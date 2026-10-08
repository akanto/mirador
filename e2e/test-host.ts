import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { cpSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const repoRoot = join(import.meta.dirname, "..");
export const notifierDir = join(homedir(), ".config", "claude-notifier");
const claudeProjectsDir = join(homedir(), ".claude", "projects");
const TRANSCRIPT_WRITERS_GRACE_MS = 2_000;

/** dash, Linux's /bin/sh, may run commands in the shell's own process group, so the busy check needs bash there. */
export const jobControlShell = process.platform === "darwin" ? "/bin/sh" : "/bin/bash";

/**
 * Test sessions must be muted in the user's real claude-notifier directory; otherwise its
 * hooks (auto-approve in yolo mode, phone mirroring) act on them. These are the markers
 * this app wrote, so cleanup can remove them again.
 */
function appMuteMarkers() {
  if (!existsSync(notifierDir)) return [];
  return readdirSync(notifierDir)
    .filter((name) => name.startsWith("mute-"))
    .filter((name) => readFileSync(join(notifierDir, name), "utf8").includes("(mirador)"));
}

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
  private readonly markersBefore = new Set(appMuteMarkers());
  readonly origin: string;
  authUrl = "";
  private process?: ChildProcess;
  private output = "";

  /** Test hosts share the user's home directory, so only a host that opts in runs statusline commands from Claude settings; its spec points a profile at settings of its own. */
  constructor(
    readonly port: number,
    private readonly options: {
      runsUserStatusLine?: boolean;
      shell?: string;
      copiesSource?: boolean;
      fakePrograms?: boolean;
      environment?: Record<string, string>;
      /** Starts with no profile, as a first run does; otherwise the host has the profile a user sets up first. */
      withoutProfiles?: boolean;
    } = {},
  ) {
    this.origin = `http://127.0.0.1:${port}`;
    this.sourceDir = options.copiesSource ? join(this.root, "source") : repoRoot;
  }

  get pid() {
    return this.process?.pid;
  }

  private copySource() {
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
    return process.env.MIRADOR_E2E_MINIMAL_ENV ? execFileSync("which", ["bun"], { encoding: "utf8" }).trim() : "bun";
  }

  /** MIRADOR_E2E_MINIMAL_ENV=1 starts the host like a bare terminal would: no inherited agent or shell variables. */
  private baseEnvironment(): NodeJS.ProcessEnv {
    if (!process.env.MIRADOR_E2E_MINIMAL_ENV) return process.env;
    const bunDir = dirname(execFileSync("which", ["bun"], { encoding: "utf8" }).trim());
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
    this.starts += 1;
    this.output = "";
    const child = spawn(this.bun, ["host/main.ts"], {
      cwd: this.sourceDir,
      env: {
        ...this.baseEnvironment(),
        MIRADOR_PORT: String(this.port),
        MIRADOR_DATA_DIR: this.dataDir,
        MIRADOR_MCP_TOKEN: this.mcpToken,
        MIRADOR_TEST_MODEL: process.env.MIRADOR_TEST_MODEL ?? "haiku",
        MIRADOR_TEST_EFFORT: process.env.MIRADOR_TEST_EFFORT ?? "low",
        MIRADOR_TEST_SKIP_USER_SETTINGS: "1",
        MIRADOR_TAILSCALE: join(this.root, "no-tailscale-on-this-machine"),
        MIRADOR_STATUSLINE: this.options.runsUserStatusLine ? "on" : "off",
        ...(this.options.shell && { SHELL: this.options.shell }),
        ...(this.options.fakePrograms && { PATH: `${this.fakeProgramsDir}:${this.baseEnvironment().PATH}` }),
        ...this.options.environment,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.process = child;
    const log = createWriteStream(join(this.root, "host.log"), { flags: "a" });
    this.logFile = log;
    const capture = (chunk: Buffer) => {
      this.output += chunk;
      log.write(chunk);
    };
    child.stdout!.on("data", capture);
    child.stderr!.on("data", capture);
    child.once("exit", (code, signal) => log.end(`\n[host exited: ${code ?? signal}]\n`));
    const deadline = Date.now() + 15_000;
    while (!this.output.includes("Mirador is running")) {
      if (Date.now() > deadline || child.exitCode !== null) throw new Error(`host did not start:\n${this.output}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    this.authUrl = `${this.origin}/auth?token=${readFileSync(join(this.dataDir, "browser-token"), "utf8").trim()}`;
  }

  async stop() {
    const child = this.process;
    if (!child || child.exitCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    this.logFile?.write(`\n${new Date().toISOString()} [test host: sending SIGTERM]\n`);
    child.kill("SIGTERM");
    await exited;
  }

  async restart() {
    await this.stop();
    await this.start();
  }

  /** Kills the host outright, as a crash does: nothing of a turn it was running gets written down. */
  async kill() {
    const child = this.process;
    if (!child || child.exitCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    await exited;
  }

  get log() {
    return this.output;
  }

  async cleanUp() {
    appMuteMarkers()
      .filter((name) => !this.markersBefore.has(name))
      .forEach((name) => rmSync(join(notifierDir, name), { force: true }));
    if (process.env.MIRADOR_E2E_KEEP) return;
    rmSync(this.root, { recursive: true, force: true });
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
