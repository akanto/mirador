import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import type { EngineServer, EngineServerState } from "../../../shared/voice-engine.ts";
import { modelName, type ThisMacService } from "../../../shared/voice-engine-models.ts";
import type { CustomEndpoint } from "../../../shared/voice.ts";
import { VoiceUnavailable } from "../voice.ts";
import type { VoiceEngineInstaller } from "./installer.ts";

const HOST = "127.0.0.1";
const SERVER_MODULES: Record<EngineServer, string[]> = { speech: ["-m", "mlx_audio.server"], voiceModel: ["-m", "mlx_lm.server"] };
const START_TIMEOUT_MS = 180_000;
const ANSWERING_POLL_MS = 250;
const STOP_GRACE_MS = 5_000;
/** A tenth of a second of silence: transcribing it makes mlx-audio load Whisper, which it otherwise does at the first real clip. */
const WARM_UP_CLIP = silentWav(1_600);

interface Running {
  /** By id: a server serves one model, and starts again for another, so that what it holds and its state stay true. */
  model: string;
  child: Subprocess;
  port: Promise<number>;
  inFlight: number;
  lastUsedAt: number;
  idleStop: Timer | null;
}

export interface VoiceEngineServersOptions {
  installer: Pick<VoiceEngineInstaller, "python" | "modelDir" | "isInstalled" | "isSetUp">;
  voiceDir: string;
  logsDir: string;
  idleMs: () => number;
  onChange: () => void;
  startTimeoutMs?: number;
}

function silentWav(samples: number) {
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + samples * 2, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16_000, 24);
  wav.writeUInt32LE(32_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples * 2, 40);
  return wav;
}

function freePort() {
  const listener = Bun.listen({ hostname: HOST, port: 0, socket: { data() {} } });
  const { port } = listener;
  listener.stop(true);
  return port;
}

/** What a pid file keeps of a server, so that a later process given the same pid is told apart from it. */
interface LeftRunning {
  pid: number;
  port: number;
}

function leftRunning(pidFile: string): LeftRunning | null {
  try {
    const { pid, port } = JSON.parse(pidFile) as Partial<LeftRunning>;
    return Number.isInteger(pid) && pid! > 0 && Number.isInteger(port) ? { pid: pid!, port: port! } : null;
  } catch {
    return null;
  }
}

function isStillServing(server: EngineServer, { pid, port }: LeftRunning) {
  const command = ` ${Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)]).stdout.toString().trim()} `;
  return command.includes(` ${SERVER_MODULES[server].join(" ")} `) && command.includes(` --port ${port} `);
}

const serverOf = (service: ThisMacService): EngineServer => (service === "recognition" ? "speech" : "voiceModel");

const logTail = (path: string) =>
  readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter((line) => !line.includes("Warning") && line.trim() !== "")
    .at(-1) ?? "";

/** Runs the engine's two servers: each starts when first used, stops when unused for a while, and stops with the host. */
export class VoiceEngineServers {
  private readonly running = new Map<EngineServer, Running>();
  private readonly state: Record<EngineServer, EngineServerState> = { speech: "stopped", voiceModel: "stopped" };

  constructor(private readonly options: VoiceEngineServersOptions) {
    this.stopLeftFromAnEarlierHost();
  }

  states() {
    return { ...this.state };
  }

  /** Lends a service's endpoint to `work`, starting its server with the model first; the server doesn't stop for being idle while work goes on. */
  async use<T>(service: ThisMacService, model: string, work: (endpoint: CustomEndpoint) => Promise<T>): Promise<T> {
    this.checkInstalled(model);
    const server = serverOf(service);
    const running = await this.runningWith(server, model);
    running.inFlight++;
    if (running.idleStop) clearTimeout(running.idleStop);
    running.idleStop = null;
    try {
      const port = await running.port;
      return await work({ url: `http://${HOST}:${port}/v1`, apiKey: "", model: this.options.installer.modelDir(model) });
    } finally {
      running.inFlight--;
      running.lastUsedAt = Date.now();
      if (running.inFlight === 0 && this.running.get(server) === running) this.stopWhenIdle(server, running);
    }
  }

  servedModels() {
    return [...this.running.values()].map(({ model }) => model);
  }

  /** For removing a model: no server reads its files any more. */
  async stopServing(model: string) {
    await Promise.all([...this.running].filter(([, running]) => running.model === model).map(([server]) => this.stop(server)));
  }

  /** Servers waiting to unload unload when the new idle time since their last use is up. */
  idleTimeChanged() {
    this.running.forEach((running, server) => {
      if (running.inFlight === 0) this.stopWhenIdle(server, running);
    });
  }

  async stop(server: EngineServer) {
    const running = this.running.get(server);
    if (!running) return;
    this.running.delete(server);
    if (running.idleStop) clearTimeout(running.idleStop);
    this.killGroup(running.child, "SIGTERM");
    const forceKill = setTimeout(() => this.killGroup(running.child, "SIGKILL"), STOP_GRACE_MS);
    await running.child.exited;
    clearTimeout(forceKill);
  }

  async stopAll() {
    await Promise.all([this.stop("speech"), this.stop("voiceModel")]);
  }

  /** For the host's exit, which can't wait for the servers to stop. */
  killAllNow() {
    this.running.forEach(({ child }) => this.killGroup(child, "SIGKILL"));
  }

  private stopWhenIdle(server: EngineServer, running: Running) {
    if (running.idleStop) clearTimeout(running.idleStop);
    running.idleStop = setTimeout(() => void this.stop(server), Math.max(0, running.lastUsedAt + this.options.idleMs() - Date.now()));
  }

  private checkInstalled(model: string) {
    const { installer } = this.options;
    if (installer.isInstalled(model)) return;
    if (!installer.isSetUp()) throw new VoiceUnavailable("Voice isn't set up on this Mac yet. Settings → Voice can set it up.");
    throw new VoiceUnavailable(`${modelName(model)} isn't on this Mac. Settings → Voice can add it.`);
  }

  private async runningWith(server: EngineServer, model: string) {
    let running = this.running.get(server);
    while (running && running.model !== model) {
      await this.stop(server);
      running = this.running.get(server);
    }
    return running ?? this.start(server, model);
  }

  private start(server: EngineServer, model: string) {
    const port = freePort();
    const child = this.spawn(server, port, model);
    const running: Running = { model, child, port: this.untilReady(server, child, port, model), inFlight: 0, lastUsedAt: Date.now(), idleStop: null };
    this.running.set(server, running);
    this.setState(server, "loading");
    running.port.then(
      () => this.setState(server, "ready"),
      () => this.forget(server, running),
    );
    child.exited.then(() => this.forget(server, running));
    return running;
  }

  private spawn(server: EngineServer, port: number, model: string) {
    const { installer, logsDir } = this.options;
    const serverArgs = server === "speech" ? [...SERVER_MODULES.speech] : [...SERVER_MODULES.voiceModel, "--model", installer.modelDir(model)];
    mkdirSync(logsDir, { recursive: true });
    const log = openSync(this.logPath(server), "w");
    const child = Bun.spawn([installer.python, ...serverArgs, "--host", HOST, "--port", String(port)], {
      env: this.environment(),
      stdin: "ignore",
      stdout: log,
      stderr: log,
      detached: true,
    });
    closeSync(log);
    mkdirSync(this.pidDir(), { recursive: true });
    writeFileSync(this.pidFile(server), JSON.stringify({ pid: child.pid, port } satisfies LeftRunning));
    return child;
  }

  /** Built from nothing, so the host's own keys and tokens stay out of the servers and their logs. */
  private environment() {
    const cache = join(this.options.voiceDir, "hf-cache");
    mkdirSync(cache, { recursive: true });
    return { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: homedir(), TMPDIR: tmpdir(), HF_HUB_OFFLINE: "1", HF_HUB_CACHE: cache };
  }

  private async untilReady(server: EngineServer, child: Subprocess, port: number, model: string) {
    const deadline = Date.now() + (this.options.startTimeoutMs ?? START_TIMEOUT_MS);
    while (!(await this.answers(port))) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`The ${server === "speech" ? "speech" : "voice model"} server on this Mac stopped while starting: ${logTail(this.logPath(server))}`);
      }
      if (Date.now() > deadline) {
        this.killGroup(child, "SIGKILL");
        throw new Error(`The ${server === "speech" ? "speech" : "voice model"} server on this Mac didn't start within ${(this.options.startTimeoutMs ?? START_TIMEOUT_MS) / 1000} seconds.`);
      }
      await Bun.sleep(ANSWERING_POLL_MS);
    }
    if (server === "speech") await this.warmUp(port, model);
    return port;
  }

  private async answers(port: number) {
    return fetch(`http://${HOST}:${port}/v1/models`, { signal: AbortSignal.timeout(2_000) }).then(
      (response) => response.ok,
      () => false,
    );
  }

  private async warmUp(port: number, model: string) {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(WARM_UP_CLIP)], { type: "audio/wav" }), "silence.wav");
    form.append("model", this.options.installer.modelDir(model));
    form.append("response_format", "json");
    await fetch(`http://${HOST}:${port}/v1/audio/transcriptions`, { method: "POST", body: form }).catch(() => {});
  }

  private forget(server: EngineServer, running: Running) {
    if (this.running.get(server) === running) this.running.delete(server);
    if (running.idleStop) clearTimeout(running.idleStop);
    if (!this.running.has(server)) {
      rmSync(this.pidFile(server), { force: true });
      this.setState(server, "stopped");
    }
  }

  private setState(server: EngineServer, state: EngineServerState) {
    if (this.state[server] === state) return;
    this.state[server] = state;
    this.options.onChange();
  }

  private killGroup(child: Subprocess, signal: NodeJS.Signals) {
    try {
      process.kill(-child.pid, signal);
    } catch {}
  }

  /** A host that crashed left its servers running; a pid file names each, and only a process still running that server on its port is stopped. */
  private stopLeftFromAnEarlierHost() {
    (["speech", "voiceModel"] as const).filter((server) => existsSync(this.pidFile(server))).forEach((server) => {
      const left = leftRunning(readFileSync(this.pidFile(server), "utf8"));
      if (left && isStillServing(server, left)) {
        try {
          process.kill(-left.pid, "SIGKILL");
        } catch {}
      }
      rmSync(this.pidFile(server), { force: true });
    });
  }

  private pidDir() {
    return join(this.options.voiceDir, "run");
  }

  private pidFile(server: EngineServer) {
    return join(this.pidDir(), `${server}.pid`);
  }

  private logPath(server: EngineServer) {
    return join(this.options.logsDir, `voice-${server === "speech" ? "speech" : "model"}.log`);
  }
}
