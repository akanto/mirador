import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { HarnessId } from "../../shared/model.ts";
import { MIRADOR_VERSION } from "../../shared/version.ts";
import { commandLine, commandShell } from "../command-shell.ts";
import { killProcessTree } from "../windows-processes.ts";

export type ConfigValue = string | boolean;

const PRELAUNCH_TIMEOUT_MS = 60_000;
const INITIALIZE_TIMEOUT_MS = 60_000;
const PRELAUNCH_OUTPUT_IN_ERRORS = 600;
const FORCE_KILL_GRACE_MS = 3000;
/** A connection closes just before its process exits; a stop that has to SIGKILL the agent takes the grace period. */
const EXIT_WAIT_MS = FORCE_KILL_GRACE_MS + 2000;
/**
 * The connection does not wait any longer for the end of an exited agent's output: a child it started can hold the
 * output open, and Bun on Windows sometimes never reports its end, which would leave the turn running for good.
 */
const LAST_OUTPUT_AFTER_EXIT_MS = 1000;
/** claude-agent-acp's extension for adding a message to the running turn, advertised in `_meta.steering` at initialize. */
const STEERING_METHOD = "_session/steering";

const latestStartByHarness = new Map<HarnessId, Promise<unknown>>();

/** Windows runs a .cmd or .bat, such as the opencode.cmd npm installs, only through cmd.exe, and refuses to spawn it otherwise. */
const isWindowsBatchFile = (program: string) => process.platform === "win32" && /\.(cmd|bat)$/i.test(program);

/** The agent's arguments are the host's own, such as `acp`, so only the program's path, which may hold spaces, needs quoting for cmd.exe. */
const spawnAgent = (program: string, args: string[], environment: Record<string, string>): ChildProcess =>
  isWindowsBatchFile(program)
    ? spawn(`"${program}"`, args, { stdio: ["pipe", "pipe", "pipe"], env: environment, shell: true })
    : spawn(program, args, { stdio: ["pipe", "pipe", "pipe"], env: environment });

export interface HarnessSpec {
  id: HarnessId;
  /** Names the agent process in messages, e.g. "Claude Code (work)". */
  label: string;
  logName: string;
  command: string[];
  environment: Record<string, string>;
  /** Shell command run before the agent starts, e.g. to bring up a local proxy. */
  prelaunch: string;
  /** Two opencode processes starting at the same moment fail with "database is locked". */
  startsOneAtATime: boolean;
}

export interface HarnessListener {
  onSessionUpdate(notification: acp.SessionNotification): void;
  onPermissionRequest(request: acp.RequestPermissionRequest, signal: AbortSignal): Promise<acp.RequestPermissionResponse>;
  onExit(harness: HarnessProcess, reason: string): void;
}

export class HarnessProcess {
  private child?: ChildProcess;
  /** Settles with why the agent process went away, e.g. "exited with 1". */
  private exited: Promise<string> = Promise.resolve("is not running");
  private connection?: acp.ClientConnection;
  private initialized?: Promise<acp.InitializeResponse>;
  private stopReason?: string;

  constructor(
    readonly spec: HarnessSpec,
    private readonly listener: HarnessListener,
    private readonly logDir: string,
    private readonly initializeTimeoutMs = INITIALIZE_TIMEOUT_MS,
  ) {}

  start(): Promise<acp.InitializeResponse> {
    this.initialized ??= this.launchInTurn().catch((error) => {
      this.initialized = undefined;
      throw error;
    });
    return this.initialized;
  }

  async newSession(request: acp.NewSessionRequest) {
    return this.agent().request(acp.methods.agent.session.new, request);
  }

  async resumeSession(request: acp.ResumeSessionRequest) {
    return this.agent().request(acp.methods.agent.session.resume, request);
  }

  async loadSession(request: acp.LoadSessionRequest) {
    return this.agent().request(acp.methods.agent.session.load, request);
  }

  async forkSession(request: acp.ForkSessionRequest) {
    return this.agent().request(acp.methods.agent.session.fork, request);
  }

  /** Lets go of a session so another agent process can take it over; a process that is not running holds none. */
  async closeSession(sessionId: string) {
    const capabilities = await this.initialized;
    if (!capabilities?.agentCapabilities?.sessionCapabilities?.close) return;
    await this.agent().request(acp.methods.agent.session.close, { sessionId });
  }

  async listSessions(cwd: string) {
    return this.agent().request(acp.methods.agent.session.list, { cwd });
  }

  async prompt(sessionId: string, prompt: acp.ContentBlock[]) {
    return this.failingWithExitReason((agent) => agent.request(acp.methods.agent.session.prompt, { sessionId, prompt }));
  }

  /**
   * Adds the message to the turn running in the session rather than starting a turn after it. False when the agent
   * cannot, or the turn has already ended, so the message is still the caller's to send.
   */
  async steer(sessionId: string, prompt: acp.ContentBlock[]): Promise<boolean> {
    if (!(await this.canSteer())) return false;
    const { outcome } = await this.agent().request<{ outcome: string }>(STEERING_METHOD, {
      sessionId,
      prompt,
      _meta: { steering: { idleBehavior: "promptRequired" } },
    });
    return outcome === "injected";
  }

  async canSteer() {
    const capabilities = await this.initialized;
    return (capabilities?._meta?.steering as { supported?: unknown } | undefined)?.supported === true;
  }

  async cancel(sessionId: string) {
    await this.agent().notify(acp.methods.agent.session.cancel, { sessionId });
  }

  async setConfigOption(sessionId: string, configId: string, value: ConfigValue) {
    const request: acp.SetSessionConfigOptionRequest =
      typeof value === "boolean" ? { sessionId, configId, type: "boolean", value } : { sessionId, configId, value };
    return this.failingWithExitReason((agent) => agent.request(acp.methods.agent.session.setConfigOption, request));
  }

  /**
   * Settles once the agent process has exited. An agent that handles the stop signal can defer it as long as it
   * likes — claude-agent-acp disposes itself on SIGTERM, which wedges when the turn is wedged — so the grace
   * period ends with SIGKILL; a connection left closed and uncleaned would fail every later prompt of its own kind.
   * Windows has no stop signal, so there the agent cannot end what it started: it is killed at once with all of it.
   * Either way the agent process went away because it was stopped, not with the exit code or signal that ended it.
   */
  stop(reason = "was stopped") {
    this.stopReason = reason;
    const child = this.child;
    this.connection?.close();
    if (process.platform === "win32" && child?.pid !== undefined) void killProcessTree(child.pid);
    else if (child) {
      child.kill();
      setTimeout(() => child.exitCode === null && child.signalCode === null && child.kill("SIGKILL"), FORCE_KILL_GRACE_MS).unref();
    }
    return this.exited;
  }

  private agent() {
    if (!this.connection) throw new Error(`The ${this.spec.label} agent is not running`);
    return this.connection.agent;
  }

  /**
   * A request the agent process goes away during fails with why it went away, rather than with the closed connection,
   * and only once the process has exited, so by then the process is known to be gone.
   */
  private async failingWithExitReason<T>(request: (agent: acp.ClientConnection["agent"]) => Promise<T>): Promise<T> {
    const connection = this.connection;
    try {
      return await request(this.agent());
    } catch (error) {
      if (!connection?.signal.aborted) throw error;
      const reason = await Promise.race([this.exited, Bun.sleep(EXIT_WAIT_MS).then(() => null)]);
      throw reason === null ? error : new Error(`The ${this.spec.label} agent process ${reason}.`);
    }
  }

  private launchInTurn() {
    if (!this.spec.startsOneAtATime) return this.launch();
    const previous = latestStartByHarness.get(this.spec.id) ?? Promise.resolve();
    const launched = previous.catch(() => {}).then(() => this.launch());
    latestStartByHarness.set(this.spec.id, launched);
    return launched;
  }

  private async launch() {
    this.stopReason = undefined;
    await this.runPrelaunch();
    const [command, ...args] = this.spec.command;
    const child = spawnAgent(command!, args, this.spec.environment);
    this.child = child;
    let exitedBecause = (_reason: string) => {};
    this.exited = new Promise((resolve) => (exitedBecause = resolve));
    let gone = false;
    const goneBecause = (reason: string) => {
      if (gone) return;
      gone = true;
      this.connection = undefined;
      this.initialized = undefined;
      this.child = undefined;
      this.stopReason = undefined;
      this.listener.onExit(this, reason);
      exitedBecause(reason);
    };
    child.on("error", (error) => child.pid === undefined && goneBecause(`could not start: ${error.message}`));
    const log = createWriteStream(this.logPath(), { flags: "a" });
    log.on("error", (error) => {
      console.error(`${new Date().toISOString()} could not write the ${this.spec.label} agent's log:`, error.message);
      child.stderr!.resume();
    });
    child.stderr!.pipe(log);
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin!),
      Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
    );
    const connection = acp
      .client({ name: "mirador" })
      .onNotification(acp.methods.client.session.update, (ctx) => this.listener.onSessionUpdate(ctx.params))
      .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
        this.listener.onPermissionRequest(ctx.params, ctx.signal),
      )
      .connect(stream);
    this.connection = connection;
    child.once("exit", (code, signal) => {
      goneBecause(this.stopReason ?? `exited with ${code ?? signal}`);
      setTimeout(() => connection.close(), LAST_OUTPUT_AFTER_EXIT_MS).unref();
    });
    return this.initialize();
  }

  /** An agent that never answers would hold up every later start of its kind, when they start one at a time. */
  private async initialize() {
    const givingUp = setTimeout(
      () => void this.stop(`did not answer within ${this.initializeTimeoutMs / 1000} s of starting`),
      this.initializeTimeoutMs,
    );
    try {
      return await this.failingWithExitReason((agent) =>
        agent.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: { name: "mirador", version: MIRADOR_VERSION },
        }),
      );
    } catch (error) {
      if (this.stopReason === undefined) void this.stop();
      throw error;
    } finally {
      clearTimeout(givingUp);
    }
  }

  /**
   * The command's output goes straight to the log file rather than through a pipe: a proxy it
   * starts in the background inherits the output and would otherwise hold the pipe open.
   */
  private async runPrelaunch() {
    if (!this.spec.prelaunch.trim()) return;
    const logPath = this.logPath();
    const logSizeBefore = existsSync(logPath) ? statSync(logPath).size : 0;
    const log = openSync(logPath, "a");
    const outcome = await new Promise<string | null>((resolve) => {
      const [program, ...args] = commandLine(commandShell(() => process.env.SHELL || "/bin/sh", this.spec.environment), this.spec.prelaunch);
      const shell = spawn(program!, args, {
        env: this.spec.environment,
        stdio: ["ignore", log, log],
      });
      const timeout = setTimeout(() => {
        shell.kill();
        resolve(`timed out after ${PRELAUNCH_TIMEOUT_MS / 1000} s`);
      }, PRELAUNCH_TIMEOUT_MS);
      shell.once("error", (error) => resolve(error.message));
      shell.once("exit", (code, signal) => {
        clearTimeout(timeout);
        resolve(code === 0 ? null : `exited with ${code ?? signal}`);
      });
    });
    closeSync(log);
    if (outcome === null) return;
    const output = readFileSync(logPath).subarray(logSizeBefore).toString().trim().slice(-PRELAUNCH_OUTPUT_IN_ERRORS);
    throw new Error(`The pre-launch command of ${this.spec.label} ${outcome}${output ? `: ${output}` : ""}`);
  }

  private logPath() {
    mkdirSync(this.logDir, { recursive: true });
    return join(this.logDir, `${this.spec.logName}.log`);
  }
}
