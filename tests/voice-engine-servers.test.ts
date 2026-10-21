import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineServerState } from "../shared/voice-engine.ts";
import type { EngineModelId } from "../host/voice/engine/catalog.ts";
import { VoiceEngineServers, type VoiceEngineServersOptions } from "../host/voice/engine/servers.ts";
import { transcribe } from "../host/voice/endpoints.ts";
import { VoiceUnavailable } from "../host/voice/voice.ts";

const fakeEngine = join(import.meta.dir, "..", "e2e", "fake-voice-engine.ts");

interface Logged {
  module: string;
  pid: number;
  event: string;
  model?: string;
  responseFormat?: string;
}

let root = "";
let servers: VoiceEngineServers | null = null;
let others: number[] = [];

afterEach(async () => {
  await servers?.stopAll();
  servers = null;
  others.forEach((pid) => isRunning(pid) && process.kill(pid, "SIGKILL"));
  others = [];
  rmSync(root, { recursive: true, force: true });
});

function isRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const logPath = () => join(root, "engine.log");

const logged = (): Logged[] =>
  existsSync(logPath())
    ? readFileSync(logPath(), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Logged)
    : [];

const startsOf = (serverModule: string) => logged().filter((entry) => entry.event === "start" && entry.module === serverModule);

/** The servers run python with an environment of their own, so the fake's settings are written into the program. */
function writePython(script: string) {
  const python = join(root, "python");
  writeFileSync(python, script);
  chmodSync(python, 0o755);
  return python;
}

const fakePython = (loadMs = 0) =>
  writePython(`#!/bin/sh
export FAKE_VOICE_ENGINE_LOG="${logPath()}" FAKE_VOICE_ENGINE_LOAD_MS=${loadMs}
exec "${process.execPath}" "${fakeEngine}" "$@"
`);

const brokenPython = () =>
  writePython(`#!/bin/sh
echo "Warning: something harmless" >&2
echo "ModuleNotFoundError: No module named 'mlx_audio'" >&2
exit 1
`);

function engineServers({ python = fakePython(), installed = ["recognition", "speech", "voiceModel"] as EngineModelId[], ...options }: Partial<VoiceEngineServersOptions> & { python?: string; installed?: EngineModelId[] } = {}) {
  const states: Record<string, EngineServerState>[] = [];
  servers = new VoiceEngineServers({
    installer: { python, modelDir: (id) => join(root, "models", id), isInstalled: (id) => installed.includes(id) },
    voiceDir: join(root, "voice"),
    logsDir: join(root, "logs"),
    idleMs: () => 60_000,
    onChange: () => states.push(servers!.states()),
    ...options,
  });
  return { servers, states };
}

async function until(condition: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(20);
  }
}

const silentClip = new Blob([new Uint8Array(44)], { type: "audio/wav" });

describe("the engine's servers", () => {
  test("start at their first use, once for uses at the same time, and lend their address and model", async () => {
    root = mkdtempSync(join(tmpdir(), "mirador-voice-servers-"));
    const { servers, states } = engineServers({ python: fakePython(300) });
    const hear = () => servers.use("recognition", (endpoint) => transcribe(endpoint, silentClip, null, { detailed: true }));
    const [first, second] = await Promise.all([hear(), hear()]);
    expect(first).toEqual({ text: "Futtasd le az e2e teszteket.", language: "hu" });
    expect(second).toEqual(first);
    expect(startsOf("mlx_audio.server")).toHaveLength(1);
    expect(states).toEqual([
      { speech: "loading", voiceModel: "stopped" },
      { speech: "ready", voiceModel: "stopped" },
    ]);
    const transcriptions = logged().filter((entry) => entry.event === "transcription");
    expect(transcriptions.map(({ responseFormat }) => responseFormat)).toEqual(["json", "verbose_json", "verbose_json"]);
    expect(new Set(transcriptions.map(({ model }) => model))).toEqual(new Set([join(root, "models", "recognition")]));
  });

  test("start the voice model's server with its model", async () => {
    root = mkdtempSync(join(tmpdir(), "mirador-voice-servers-"));
    const { servers } = engineServers();
    const endpoint = await servers.use("voiceModel", async (endpoint) => endpoint);
    expect(endpoint).toMatchObject({ url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/v1$/), apiKey: "", model: join(root, "models", "voiceModel") });
    expect(startsOf("mlx_lm.server").map(({ model }) => model)).toEqual([join(root, "models", "voiceModel")]);
    expect(servers.states()).toEqual({ speech: "stopped", voiceModel: "ready" });
  });

  test("stop once unused for the idle time, but not while work goes on", async () => {
    root = mkdtempSync(join(tmpdir(), "mirador-voice-servers-"));
    const { servers } = engineServers({ idleMs: () => 200 });
    await servers.use("recognition", async () => Bun.sleep(500));
    expect(servers.states().speech).toBe("ready");
    const { pid } = startsOf("mlx_audio.server")[0]!;
    await until(() => servers.states().speech === "stopped");
    expect(isRunning(pid)).toBe(false);
    expect(existsSync(join(root, "voice", "run", "speech.pid"))).toBe(false);
    await servers.use("recognition", async () => {});
    expect(startsOf("mlx_audio.server")).toHaveLength(2);
  });

  test("use again within the idle time keeps the server", async () => {
    root = mkdtempSync(join(tmpdir(), "mirador-voice-servers-"));
    const { servers } = engineServers({ idleMs: () => 300 });
    await servers.use("recognition", async () => {});
    await Bun.sleep(200);
    await servers.use("recognition", async () => {});
    await Bun.sleep(200);
    expect(servers.states().speech).toBe("ready");
    expect(startsOf("mlx_audio.server")).toHaveLength(1);
  });

  test("stop with the host, all of each server's processes", async () => {
    root = mkdtempSync(join(tmpdir(), "mirador-voice-servers-"));
    const { servers } = engineServers();
    await Promise.all([servers.use("recognition", async () => {}), servers.use("voiceModel", async () => {})]);
    const pids = logged()
      .filter((entry) => entry.event === "start")
      .map(({ pid }) => pid);
    await servers.stopAll();
    expect(pids.filter(isRunning)).toEqual([]);
    expect(servers.states()).toEqual({ speech: "stopped", voiceModel: "stopped" });
  });

  test("say why a server stopped while starting, and try again at the next use", async () => {
    root = mkdtempSync(join(tmpdir(), "mirador-voice-servers-"));
    const { servers } = engineServers({ python: brokenPython() });
    await expect(servers.use("recognition", async () => {})).rejects.toThrow("The speech server on this Mac stopped while starting: ModuleNotFoundError: No module named 'mlx_audio'");
    await until(() => servers.states().speech === "stopped");
    fakePython();
    expect(await servers.use("recognition", async () => "heard")).toBe("heard");
  });

  test("give up on a server that doesn't answer in time", async () => {
    root = mkdtempSync(join(tmpdir(), "mirador-voice-servers-"));
    const { servers } = engineServers({ python: fakePython(10_000), startTimeoutMs: 1_500 });
    await expect(servers.use("voiceModel", async () => {})).rejects.toThrow("The voice model server on this Mac didn't start within 1.5 seconds.");
    await until(() => servers.states().voiceModel === "stopped");
    const { pid } = startsOf("mlx_lm.server")[0]!;
    await until(() => !isRunning(pid));
  });

  test("refuse services whose models aren't set up", async () => {
    root = mkdtempSync(join(tmpdir(), "mirador-voice-servers-"));
    const nothing = engineServers({ installed: [] }).servers;
    await expect(nothing.use("recognition", async () => {})).rejects.toThrow(new VoiceUnavailable("Voice isn't set up on this Mac yet. Settings → Voice can set it up."));
    const withoutVoiceModel = engineServers({ installed: ["recognition", "speech"] }).servers;
    await expect(withoutVoiceModel.use("voiceModel", async () => {})).rejects.toThrow(new VoiceUnavailable("The voice model isn't set up on this Mac. Settings → Voice can add it."));
    expect(logged()).toEqual([]);
  });

  test("stop servers a crashed host left running, and nothing else a pid file names", async () => {
    root = mkdtempSync(join(tmpdir(), "mirador-voice-servers-"));
    const python = fakePython();
    const serving = (port: number) => Bun.spawn([python, "-m", "mlx_lm.server", "--host", "127.0.0.1", "--port", String(port)], { detached: true, stdio: ["ignore", "ignore", "ignore"] });
    const leftOver = serving(0);
    const usersOwn = serving(0);
    others.push(leftOver.pid, usersOwn.pid);
    await until(() => startsOf("mlx_lm.server").length === 2);
    const runDir = join(root, "voice", "run");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "voiceModel.pid"), JSON.stringify({ pid: leftOver.pid, port: 0 }));
    writeFileSync(join(runDir, "speech.pid"), JSON.stringify({ pid: usersOwn.pid, port: 0 }));
    engineServers({ python });
    await leftOver.exited;
    expect(isRunning(usersOwn.pid), "a voice model server isn't the speech server the pid file named").toBe(true);
    expect(existsSync(join(runDir, "voiceModel.pid"))).toBe(false);
    expect(existsSync(join(runDir, "speech.pid"))).toBe(false);

    const onAnotherPort = serving(0);
    others.push(onAnotherPort.pid);
    await until(() => startsOf("mlx_lm.server").length === 3);
    writeFileSync(join(runDir, "voiceModel.pid"), JSON.stringify({ pid: onAnotherPort.pid, port: 1 }));
    writeFileSync(join(runDir, "speech.pid"), "not a pid file");
    engineServers({ python });
    expect(isRunning(onAnotherPort.pid), "a server on another port isn't the one the pid file named").toBe(true);
    expect(existsSync(join(runDir, "speech.pid"))).toBe(false);
  });
});
