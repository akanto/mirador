import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { HarnessId } from "../../shared/model.ts";
import { MIRADOR_VERSION } from "../../shared/version.ts";

export type ConfigValue = string | boolean;

const PRELAUNCH_TIMEOUT_MS = 60_000;
const PRELAUNCH_OUTPUT_IN_ERRORS = 600;
const FORCE_KILL_GRACE_MS = 3000;
/** A connection closes just before its process exits; a stop that has to SIGKILL the agent takes the grace period. */
const EXIT_WAIT_MS = FORCE_KILL_GRACE_MS + 2000;
/** claude-agent-acp's extension for adding a message to the running turn, advertised in `_meta.steering` at initialize. */
const STEERING_METHOD = "_session/steering";

const latestStartByHarness = new Map<HarnessId, Promise<unknown>>();

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
   */
  stop(reason?: string) {
    this.stopReason = reason;
    const child = this.child;
    this.connection?.close();
    child?.kill();
    if (child) setTimeout(() => child.exitCode === null && child.signalCode === null && child.kill("SIGKILL"), FORCE_KILL_GRACE_MS).unref();
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
    await this.runPrelaunch();
    const [command, ...args] = this.spec.command;
    const child = spawn(command!, args, { stdio: ["pipe", "pipe", "pipe"], env: this.spec.environment });
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
    child.stderr!.pipe(createWriteStream(this.logPath(), { flags: "a" }));
    child.once("exit", (code, signal) => goneBecause(this.stopReason ?? `exited with ${code ?? signal}`));
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin!),
      Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
    );
    this.connection = acp
      .client({ name: "mirador" })
      .onNotification(acp.methods.client.session.update, (ctx) => this.listener.onSessionUpdate(ctx.params))
      .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
        this.listener.onPermissionRequest(ctx.params, ctx.signal),
      )
      .connect(stream);
    return this.failingWithExitReason((agent) =>
      agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "mirador", version: MIRADOR_VERSION },
      }),
    );
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
      const shell = spawn(process.env.SHELL || "/bin/sh", ["-c", this.spec.prelaunch], {
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
