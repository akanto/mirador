import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { accessSync, chmodSync, constants, cpSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { muteMarkerName, MUTED_LIST_FILE, mutedListAt } from "../host/notifier.ts";
import { HOST_RELAUNCH, HOST_RESTART_EXIT_CODE } from "../shared/host-relaunch.ts";
import { freePorts } from "./free-ports.ts";
import { processTreeOf, waitForProcessesToEnd } from "./process-tree.ts";

const repoRoot = join(import.meta.dirname, "..");
const notifierDir = join(homedir(), ".config", "claude-notifier");
const claudeProjectsDir = join(homedir(), ".claude", "projects");
const TRANSCRIPT_WRITERS_GRACE_MS = 2_000;
/** As long as a host restart waits for its services to stop (SERVICES_STOP_TIMEOUT_MS in host/restart.ts). */
const HOST_PROCESSES_EXIT_TIMEOUT_MS = 5_000;

/** dash, Linux's /bin/sh, may run commands in the shell's own process group, so the busy check needs bash there. */
export const jobControlShell = process.platform === "darwin" ? "/bin/sh" : "/bin/bash";

/** What a spec's terminals and ! commands run unless it picks a shell: the developer's own shell would read their ~/.zshrc, which can stall a spec. */
export const defaultShell = "/bin/sh";

/**
 * A path for a spec's own folder, to make in its hooks: Playwright also imports spec files in a process that never runs
 * their hooks, so a folder made on import is never removed.
 */
export const scratchPath = (name: string) => join(tmpdir(), `mirador-e2e-${name}-${crypto.randomUUID().slice(0, 8)}`);

const isRunnableFile = (path: string) => {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

export const foldersOnPath = () => (process.env.PATH ?? "").split(delimiter).filter(Boolean);

/** The first of `folders` that `name` runs from: Windows finds a program with an extension from PATHEXT. */
export function programIn(folders: string[], name: string): string | undefined {
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  return folders.flatMap((folder) => extensions.map((extension) => join(folder, name + extension))).find(isRunnableFile);
}

/** Where `name` runs from on PATH, as `which` says: Windows has no which. */
export function programOnPath(name: string): string {
  const program = programIn(foldersOnPath(), name);
  if (!program) throw new Error(`${name} is not on PATH`);
  return program;
}

const isWindowsBatchFile = (program: string) => process.platform === "win32" && /\.(cmd|bat)$/i.test(program);

/** Node runs a Windows .cmd, such as npm's opencode.cmd, only through cmd.exe, which splits unquoted arguments at spaces. */
export function spawnProgram(program: string, args: string[], options: SpawnOptions): ChildProcess {
  if (!isWindowsBatchFile(program)) return spawn(program, args, options);
  return spawn(`"${program}"`, args.map((arg) => `"${arg}"`), { ...options, shell: true });
}

/**
 * A program named `name` in `directory` that runs `script` on Bun with `environment` set. Windows runs no script without
 * an extension, so there it is a name.cmd.
 */
export function writeBunProgram(directory: string, name: string, script: string, environment: Record<string, string> = {}) {
  mkdirSync(directory, { recursive: true });
  if (process.platform === "win32") {
    const settings = Object.entries(environment).map(([variable, value]) => `@set "${variable}=${value}"\r\n`);
    writeFileSync(join(directory, `${name}.cmd`), `${settings.join("")}@bun "${script}" %*\r\n`);
    return;
  }
  const settings = Object.entries(environment).map(([variable, value]) => `${variable}='${value}' `);
  writeFileSync(join(directory, name), `#!/bin/sh\n${settings.join("")}exec bun '${script}' "$@"\n`);
  chmodSync(join(directory, name), 0o755);
}

/** Windows names it Path; a second key named PATH beside it would leave which one the host gets to chance. */
const pathVariableOf = (environment: NodeJS.ProcessEnv) => Object.keys(environment).find((name) => name.toUpperCase() === "PATH") ?? "PATH";

const withFirstOnPath = (environment: NodeJS.ProcessEnv, directory: string) => {
  const pathVariable = pathVariableOf(environment);
  return { [pathVariable]: [directory, environment[pathVariable]].filter(Boolean).join(delimiter) };
};

interface TestHostOptions {
  /** Test hosts share the user's home directory, so only a host that opts in runs statusline commands from Claude settings; its spec points a profile at settings of its own. */
  runsUserStatusLine?: boolean;
  shell?: string;
  copiesSource?: boolean;
  fakePrograms?: boolean;
  /** Given the host's port when it depends on it, such as an address that leads to the host. */
  environment?: Record<string, string> | ((port: number) => Record<string, string>);
  /** Starts with no profile, as a first run does; otherwise the host has the profile a user sets up first. */
  withoutProfiles?: boolean;
}

/** The host's own port, the canvas assets port after it, and the two after those, on which it serves the network. */
const PORTS_PER_HOST = 4;
/** Another host, of this run or another, may take a port between the look for free ones and this host's start. */
const PORT_ATTEMPTS = 3;
const PORT_TAKEN = /EADDRINUSE|Is port \d+ in use/;

const timesRunningIn = (log: string) => log.split("Mirador is running").length - 1;

/** Runs the real host (and through it a real Claude Code on a cheap model) in throwaway directories. */
export class TestHost {
  /** Only a path until start(): Playwright also imports spec files in a process that never runs their hooks. */
  readonly root = join(tmpdir(), `mirador-e2e-${crypto.randomUUID().slice(0, 8)}`);
  readonly dataDir = join(this.root, "data");
  readonly projectDir = join(this.root, "project");
  /** With the fakePrograms option, programs here come first on the host's PATH (stand-ins for gh, idea, …). */
  readonly fakeProgramsDir = join(this.root, "fake-programs");
  /** Where the host runs from: the repository, or a copy of its source that the spec may edit. */
  readonly sourceDir: string;
  private starts = 0;
  private logFile?: import("node:fs").WriteStream;
  private readonly mutedBySpec = new Set<string>();
  private firstPort?: number;
  private readonly options: TestHostOptions;
  authUrl = "";
  private process?: ChildProcess;
  private output = "";
  private startedAgain?: Promise<void>;
  private stopRequested = false;

  /** A port number first is what specs gave before hosts took free ports themselves; it is not used. */
  constructor(optionsOrUnusedPort: TestHostOptions | number = {}, options: TestHostOptions = {}) {
    this.options = typeof optionsOrUnusedPort === "number" ? options : optionsOrUnusedPort;
    this.sourceDir = this.options.copiesSource ? join(this.root, "source") : repoRoot;
  }

  /** The host's own port, which it has from its first start on: start() takes ports nothing else listens on. */
  get port() {
    if (this.firstPort === undefined) throw new Error("A test host has no port until it starts: read it in a hook or a test, not as the spec loads.");
    return this.firstPort;
  }

  get origin() {
    return `http://127.0.0.1:${this.port}`;
  }

  get pid() {
    return this.process?.pid;
  }

  /** start() does it too; a spec calls it first to prepare the copy, making it a git checkout for one. */
  copySource() {
    if (existsSync(this.sourceDir)) return;
    ["host", "shared", "web"].forEach((directory) => cpSync(join(repoRoot, directory), join(this.sourceDir, directory), { recursive: true }));
    ["package.json", "tsconfig.json", "bun.lock"].forEach((file) => cpSync(join(repoRoot, file), join(this.sourceDir, file)));
    symlinkSync(join(repoRoot, "node_modules"), join(this.sourceDir, "node_modules"));
  }

  /** A fresh token per start, like production, so resume must re-supply it to the agent. */
  get mcpToken() {
    return `e2e-mcp-token-${this.starts}`;
  }

  /** Written by the host on its first start and kept, like the browser token. */
  get scriptToken() {
    return readFileSync(join(this.dataDir, "script-token"), "utf8").trim();
  }

  /** Runs Mirador's command line, as `mirador <args>` would on this host's machine, and gives what it printed. */
  mirador(...args: string[]) {
    return execFileSync("bun", ["host/cli.ts", ...args], {
      cwd: this.sourceDir,
      encoding: "utf8",
      env: { ...process.env, MIRADOR_PORT: String(this.port), MIRADOR_DATA_DIR: this.dataDir },
    });
  }

  private get bun() {
    return process.env.MIRADOR_E2E_MINIMAL_ENV ? programOnPath("bun") : "bun";
  }

  /** MIRADOR_E2E_MINIMAL_ENV=1 starts the host like a bare terminal would: no inherited agent or shell variables. */
  private baseEnvironment(): NodeJS.ProcessEnv {
    if (!process.env.MIRADOR_E2E_MINIMAL_ENV) return process.env;
    const bunDir = dirname(programOnPath("bun"));
    return {
      HOME: homedir(),
      USER: process.env.USER,
      TMPDIR: process.env.TMPDIR,
      LANG: "en_US.UTF-8",
      PATH: [bunDir, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    };
  }

  async start() {
    if (!existsSync(this.projectDir)) {
      mkdirSync(this.projectDir, { recursive: true });
      writeFileSync(join(this.projectDir, "README.md"), "# e2e project\n");
    }
    if (this.options.copiesSource) this.copySource();
    if (this.starts === 0 && !this.options.withoutProfiles) {
      mkdirSync(this.dataDir, { recursive: true });
      execFileSync(this.bun, [join(repoRoot, "e2e", "seed-profile.ts"), this.sourceDir, join(this.dataDir, "state.sqlite")]);
    }
    if (this.firstPort !== undefined) return this.launch(this.firstPort);
    for (let attempt = 1; ; attempt++) {
      const port = await freePorts(PORTS_PER_HOST);
      try {
        await this.launch(port);
        this.firstPort = port;
        return;
      } catch (error) {
        if (attempt === PORT_ATTEMPTS || !PORT_TAKEN.test(this.output)) throw error;
      }
    }
  }

  private async launch(port: number) {
    this.starts += 1;
    this.output = "";
    this.stopRequested = false;
    await this.run(port, this.environmentFor(port));
  }

  private environmentFor(port: number): NodeJS.ProcessEnv {
    return {
      ...this.baseEnvironment(),
      MIRADOR_PORT: String(port),
      MIRADOR_DATA_DIR: this.dataDir,
      MIRADOR_MCP_TOKEN: this.mcpToken,
      MIRADOR_TEST_MODEL: process.env.MIRADOR_TEST_MODEL ?? "haiku",
      MIRADOR_TEST_EFFORT: process.env.MIRADOR_TEST_EFFORT ?? "low",
      MIRADOR_TEST_SKIP_USER_SETTINGS: "1",
      MIRADOR_TAILSCALE: join(this.root, "no-tailscale-on-this-machine"),
      MIRADOR_STATUSLINE: this.options.runsUserStatusLine ? "on" : "off",
      MIRADOR_NEWER_VERSION_CHECK: "off",
      SHELL: this.options.shell ?? defaultShell,
      ...(process.platform === "win32" && { [HOST_RELAUNCH.restartExitCode]: String(HOST_RESTART_EXIT_CODE) }),
      ...(this.options.fakePrograms && withFirstOnPath(this.baseEnvironment(), this.fakeProgramsDir)),
      ...(typeof this.options.environment === "function" ? this.options.environment(port) : this.options.environment),
    };
  }

  /** Runs the host until it says it is running once more than this test host's log already has it. */
  private async run(port: number, env: NodeJS.ProcessEnv) {
    const timesRunningBefore = timesRunningIn(this.output);
    const child = spawn(this.bun, ["host/main.ts"], { cwd: this.sourceDir, env, stdio: ["ignore", "pipe", "pipe"] });
    this.process = child;
    const log = createWriteStream(join(this.root, "host.log"), { flags: "a" });
    this.logFile = log;
    const capture = (chunk: Buffer) => {
      this.output += chunk;
      log.write(chunk);
    };
    child.stdout!.on("data", capture);
    child.stderr!.on("data", capture);
    child.once("exit", (code, signal) => {
      log.end(`\n[host exited: ${code ?? signal}]\n`);
      if (code === HOST_RESTART_EXIT_CODE && this.process === child && !this.stopRequested) this.startedAgain = this.startAgain(port, env);
    });
    const deadline = Date.now() + 15_000;
    while (timesRunningIn(this.output) === timesRunningBefore) {
      if (Date.now() > deadline || child.exitCode !== null) throw new Error(`host did not start:\n${this.output}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    this.authUrl = `http://127.0.0.1:${port}/auth?token=${readFileSync(join(this.dataDir, "browser-token"), "utf8").trim()}`;
  }

  /**
   * Windows has no re-execution, so a host restarting there exits with the code it was given, and the test host starts
   * it again with the same environment, as the desktop app does.
   */
  private startAgain(port: number, env: NodeJS.ProcessEnv) {
    return this.run(port, env).catch(() => {
      this.output += "\n[test host: the host did not start again]\n";
    });
  }

  /**
   * The host exits once its agents and shells have ended, or after SERVICES_STOP_TIMEOUT_MS (host/restart.ts) at the
   * latest; anything still running then is waited for here and killed, so cleanUp never removes the root under a writer.
   */
  async stop() {
    await this.startedAgain;
    this.stopRequested = true;
    const child = this.process;
    if (!child || child.exitCode !== null) return;
    const hostProcesses = processTreeOf(child.pid!);
    const exited = new Promise((resolve) => child.once("exit", resolve));
    this.logFile?.write(`\n${new Date().toISOString()} [test host: sending SIGTERM]\n`);
    child.kill("SIGTERM");
    await exited;
    await waitForProcessesToEnd(hostProcesses, HOST_PROCESSES_EXIT_TIMEOUT_MS);
  }

  async restart() {
    await this.stop();
    await this.start();
  }

  /** Kills the host outright, as a crash does: nothing of a turn it was running gets written down. */
  async kill() {
    await this.startedAgain;
    this.stopRequested = true;
    const child = this.process;
    if (!child || child.exitCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    await exited;
  }

  get log() {
    return this.output;
  }

  /**
   * Test sessions must be muted in the user's real claude-notifier directory; otherwise its hooks (auto-approve in yolo
   * mode, phone mirroring) act on them. This mutes a session the spec runs itself, as the host mutes its own.
   */
  muteNotifier(sessionId: string) {
    if (!existsSync(notifierDir)) return;
    writeFileSync(join(notifierDir, muteMarkerName(sessionId)), "e2e terminal session (mirador)");
    this.mutedBySpec.add(sessionId);
  }

  /** Only this host's markers: hosts beside it, of this run or another, still need theirs. */
  private unmuteOwnSessions() {
    const mutedByHost = mutedListAt(join(this.dataDir, MUTED_LIST_FILE));
    [...mutedByHost, ...this.mutedBySpec].forEach((sessionId) => rmSync(join(notifierDir, muteMarkerName(sessionId)), { force: true }));
  }

  async cleanUp() {
    this.unmuteOwnSessions();
    if (process.env.MIRADOR_E2E_KEEP) return;
    rmSync(this.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    this.removeClaudeTranscripts();
    await new Promise((resolve) => setTimeout(resolve, TRANSCRIPT_WRITERS_GRACE_MS));
    this.removeClaudeTranscripts();
  }

  /** Claude Code processes outlive the host briefly and write a last "interrupted" entry while they stop. */
  private removeClaudeTranscripts() {
    this.claudeTranscriptDirs().forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  }

  /** Claude Code keeps a transcript directory per working directory; these are the test project's. */
  private claudeTranscriptDirs() {
    if (!existsSync(claudeProjectsDir)) return [];
    const rootName = basename(this.root);
    return readdirSync(claudeProjectsDir)
      .filter((name) => name.includes(rootName))
      .map((name) => join(claudeProjectsDir, name));
  }
}
