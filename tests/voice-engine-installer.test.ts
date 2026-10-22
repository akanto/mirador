import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VoiceEngineSetup } from "../shared/voice-engine.ts";
import type { EngineSources } from "../host/voice/engine/catalog.ts";
import { VoiceEngineInstaller, type VoiceEngineInstallerOptions } from "../host/voice/engine/installer.ts";

const root = mkdtempSync(join(tmpdir(), "mirador-voice-installer-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

interface RepoFile {
  path: string;
  content: Buffer<ArrayBuffer>;
  lfs: boolean;
}

const file = (path: string, content: string | Buffer, lfs = false): RepoFile => ({ path, content: Buffer.from(content), lfs });
const repos: Record<string, RepoFile[]> = {
  "mlx-community/whisper": [file("config.json", '{"model_type":"whisper"}'), file("model.safetensors", Buffer.alloc(300_000, 7), true), file("README.md", "# Whisper")],
  "mlx-community/Kokoro": [file("config.json", "{}"), file("voices/am_fenrir.safetensors", Buffer.alloc(2_000, 3), true), file("samples/hello.wav", "RIFF")],
  "mlx-community/gemma": [file("config.json", '{"model_type":"gemma4"}'), file("model.safetensors", Buffer.alloc(50_000, 9), true)],
};

const sha256 = (content: Buffer) => createHash("sha256").update(content).digest("hex");
const gitBlobSha1 = (content: Buffer) => createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");

/** A uv that only says what it was asked to do, and makes the venv's python for the installer to find. */
const fakeUv = `#!/bin/sh
echo "$@" >> "${join(root, "uv-calls.log")}"
if [ -f "${join(root, "uv-fails")}" ] && [ "$1" = "pip" ]; then echo "error: no wheel for mlx" >&2; exit 2; fi
if [ "$1" = "venv" ]; then mkdir -p "$6/bin" && touch "$6/bin/python"; fi
exit 0
`;

function uvArchive() {
  const folder = join(root, "uv-build", "uv-aarch64-apple-darwin");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "uv"), fakeUv);
  chmodSync(join(folder, "uv"), 0o755);
  const archive = join(root, "uv.tar.gz");
  Bun.spawnSync(["tar", "-czf", archive, "-C", join(root, "uv-build"), "uv-aarch64-apple-darwin"]);
  return readFileSync(archive);
}
const uv = uvArchive();

let requests: { path: string; range: string | null }[] = [];
let failOnce = new Set<string>();
let corrupted = new Set<string>();
let slowly = new Set<string>();

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const { pathname } = new URL(request.url);
    requests.push({ path: pathname, range: request.headers.get("range") });
    if (failOnce.delete(pathname)) return new Response("busy", { status: 503 });
    if (pathname === "/uv.tar.gz") return new Response(new Uint8Array(uv));
    const tree = pathname.match(/^\/api\/models\/(.+)\/tree\/rev1$/);
    if (tree) {
      return Response.json(
        repos[tree[1]!]!.map(({ path, content, lfs }) => ({ type: "file", path, size: content.length, oid: gitBlobSha1(content), ...(lfs && { lfs: { oid: sha256(content) } }) })),
      );
    }
    const resolved = pathname.match(/^\/(.+?\/[^/]+)\/resolve\/rev1\/(.+)$/);
    const repoFile = resolved && repos[resolved[1]!]?.find(({ path }) => path === decodeURIComponent(resolved[2]!));
    if (!repoFile) return new Response("not found", { status: 404 });
    const content = corrupted.has(pathname) ? Buffer.alloc(repoFile.content.length, 1) : repoFile.content;
    const from = Number(request.headers.get("range")?.match(/bytes=(\d+)-/)?.[1] ?? 0);
    const rest = content.subarray(from);
    const headers: Record<string, string> = from ? { "content-range": `bytes ${from}-${content.length - 1}/${content.length}` } : {};
    if (!slowly.has(pathname)) return new Response(new Uint8Array(rest), { status: from ? 206 : 200, headers });
    const chunks = Array.from({ length: Math.ceil(rest.length / 10_000) }, (_, index) => rest.subarray(index * 10_000, (index + 1) * 10_000));
    const body = new ReadableStream({
      async pull(controller) {
        await Bun.sleep(20);
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
    });
    return new Response(body, { status: from ? 206 : 200, headers });
  },
});
afterAll(() => server.stop(true));

const origin = `http://127.0.0.1:${server.port}`;
const lockFile = join(root, "requirements.lock");
writeFileSync(lockFile, "mlx==0.32.4 --hash=sha256:00\n");

const sources = (overrides: Partial<EngineSources> = {}): EngineSources => ({
  uv: { url: `${origin}/uv.tar.gz`, sha256: sha256(uv) },
  pythonVersion: "3.12.15",
  lockFile,
  modelsUrl: origin,
  models: {
    recognition: { repo: "mlx-community/whisper", revision: "rev1", bytes: 300_000 },
    speech: { repo: "mlx-community/Kokoro", revision: "rev1", bytes: 2_000 },
    voiceModel: { repo: "mlx-community/gemma", revision: "rev1", bytes: 50_000 },
  },
  ...overrides,
});

let voiceDir = "";
let seen: VoiceEngineSetup[] = [];
beforeEach(() => {
  voiceDir = mkdtempSync(join(root, "voice-"));
  requests = [];
  seen = [];
  failOnce = new Set();
  corrupted = new Set();
  slowly = new Set();
  rmSync(join(root, "uv-calls.log"), { force: true });
  rmSync(join(root, "uv-fails"), { force: true });
});

function installerWith(options: Partial<VoiceEngineInstallerOptions> = {}) {
  const installer: VoiceEngineInstaller = new VoiceEngineInstaller({
    voiceDir,
    logsDir: join(voiceDir, "..", "logs"),
    sources: sources(),
    fakePython: null,
    freeBytes: async () => 1e12,
    platform: { os: "darwin", cpu: "arm64", darwinMajor: 25 },
    onChange: () => seen.push(installer.status().setup),
    ...options,
  });
  return installer;
}

const settled = (installer: VoiceEngineInstaller) =>
  new Promise<VoiceEngineSetup>((resolve) => {
    const check = setInterval(() => {
      const { setup } = installer.status();
      if (setup.state !== "setting-up") {
        clearInterval(check);
        resolve(setup);
      }
    }, 5);
  });

const uvCalls = () => readFileSync(join(root, "uv-calls.log"), "utf8").trim().split("\n");
const modelFile = (folder: string, path: string) => join(voiceDir, "models", folder, path);

describe("setting up voice on this Mac", () => {
  test("installs uv, Python and the speech servers, downloads the models the servers read, and a later host finds it set up", async () => {
    const installer = installerWith();
    installer.setUp(false);
    expect(await settled(installer)).toMatchObject({ state: "set-up", withVoiceModel: false });

    expect(uvCalls()).toEqual([
      "python install 3.12.15 --no-bin --no-config",
      `venv --python 3.12.15 --managed-python --clear ${join(voiceDir, "venv")} --no-config`,
      `pip install --require-hashes -r ${lockFile} --python ${join(voiceDir, "venv", "bin", "python")} --no-config`,
    ]);
    expect(readFileSync(modelFile("whisper", "model.safetensors"))).toEqual(repos["mlx-community/whisper"]![1]!.content);
    expect(readFileSync(modelFile("Kokoro", "voices/am_fenrir.safetensors"))).toEqual(repos["mlx-community/Kokoro"]![1]!.content);
    expect(existsSync(modelFile("whisper", "README.md")) || existsSync(modelFile("Kokoro", "samples/hello.wav"))).toBe(false);
    expect(existsSync(join(voiceDir, "models", "gemma"))).toBe(false);
    expect(installer.modelDir("speech")).toBe(join(voiceDir, "models", "Kokoro"));

    const steps = seen.flatMap((setup) => (setup.state === "setting-up" ? [setup.step] : []));
    expect([...new Set(steps)]).toEqual(["space", "uv", "python", "packages", "models"]);
    expect(seen.find((setup) => setup.state === "setting-up" && setup.step === "models")).toMatchObject({ done: 0, total: 302_000 + 2 + 24 });

    const later = installerWith();
    await later.load();
    expect(later.status().setup).toMatchObject({ state: "set-up", withVoiceModel: false });
    expect((later.status().setup as { bytesOnDisk: number }).bytesOnDisk).toBeGreaterThan(300_000);
  });

  test("adding the voice model later downloads only what is new", async () => {
    const installer = installerWith();
    installer.setUp(false);
    await settled(installer);
    requests = [];
    installer.setUp(true);
    expect(await settled(installer)).toMatchObject({ state: "set-up", withVoiceModel: true });
    expect(requests.map(({ path }) => path).filter((path) => path.includes("/resolve/"))).toEqual([
      "/mlx-community/gemma/resolve/rev1/config.json",
      "/mlx-community/gemma/resolve/rev1/model.safetensors",
    ]);
    expect(uvCalls().filter((call) => call.startsWith("pip"))).toHaveLength(1);
  });

  test("picks up an interrupted download where it stopped, and asks again after a server's passing failure", async () => {
    const whole = repos["mlx-community/whisper"]![1]!.content;
    mkdirSync(join(voiceDir, "models", "whisper"), { recursive: true });
    writeFileSync(`${modelFile("whisper", "model.safetensors")}.part`, whole.subarray(0, 120_000));
    failOnce.add("/mlx-community/whisper/resolve/rev1/model.safetensors");
    const installer = installerWith();
    installer.setUp(false);
    expect(await settled(installer)).toMatchObject({ state: "set-up" });
    const asked = requests.filter(({ path }) => path === "/mlx-community/whisper/resolve/rev1/model.safetensors");
    expect(asked.map(({ range }) => range)).toEqual(["bytes=120000-", "bytes=120000-"]);
    expect(readFileSync(modelFile("whisper", "model.safetensors"))).toEqual(whole);
  });

  test("a file that comes in different from what Hugging Face lists is thrown away, and setup says so", async () => {
    corrupted.add("/mlx-community/Kokoro/resolve/rev1/voices/am_fenrir.safetensors");
    const installer = installerWith();
    installer.setUp(false);
    const setup = await settled(installer);
    expect(setup).toMatchObject({ state: "failed" });
    expect((setup as { problem: string }).problem).toContain("came in different from what was expected");
    expect(existsSync(modelFile("Kokoro", "voices/am_fenrir.safetensors")) || existsSync(`${modelFile("Kokoro", "voices/am_fenrir.safetensors")}.part`)).toBe(false);
  });

  test("adding the voice model can fail without undoing what was set up, and trying again forgets why it failed", async () => {
    const installer = installerWith();
    installer.setUp(false);
    await settled(installer);
    corrupted.add("/mlx-community/gemma/resolve/rev1/model.safetensors");
    installer.setUp(true);
    const failed = await settled(installer);
    expect(failed).toMatchObject({ state: "set-up", withVoiceModel: false, problem: expect.stringContaining("came in different from what was expected") });
    expect(installer.isInstalled("recognition")).toBe(true);
    expect(installer.isInstalled("voiceModel")).toBe(false);

    corrupted = new Set();
    installer.setUp(true);
    expect(await settled(installer)).toEqual({ state: "set-up", withVoiceModel: true, bytesOnDisk: expect.any(Number) });
    expect(installer.isInstalled("voiceModel")).toBe(true);
  });

  test("a uv download that isn't the pinned one stops setup before anything runs", async () => {
    const installer = installerWith({ sources: sources({ uv: { url: `${origin}/uv.tar.gz`, sha256: "0".repeat(64) } }) });
    installer.setUp(false);
    expect(await settled(installer)).toMatchObject({ state: "failed" });
    expect(existsSync(join(root, "uv-calls.log"))).toBe(false);
  });

  test("a failing install shows what uv said", async () => {
    writeFileSync(join(root, "uv-fails"), "");
    const installer = installerWith();
    installer.setUp(false);
    expect(await settled(installer)).toEqual({ state: "failed", withVoiceModel: false, problem: "uv pip failed: error: no wheel for mlx" });
  });

  test("doesn't start without room for everything and some to spare", async () => {
    const installer = installerWith({ freeBytes: async () => 4e9 });
    installer.setUp(true);
    expect(await settled(installer)).toEqual({ state: "failed", withVoiceModel: true, problem: "Setting up needs 5.0 GB free, and this Mac has 4.0 GB." });
    expect(requests.filter(({ path }) => path.includes("/resolve/"))).toHaveLength(0);
  });

  test("Cancel keeps what came in for the next try, and Remove takes everything away", async () => {
    slowly.add("/mlx-community/whisper/resolve/rev1/model.safetensors");
    const installer = installerWith();
    installer.setUp(false);
    while (!seen.some((setup) => setup.state === "setting-up" && setup.step === "models" && setup.done > 20_000)) await Bun.sleep(10);
    installer.cancel();
    expect(await settled(installer)).toEqual({ state: "not-set-up" });
    expect(existsSync(`${modelFile("whisper", "model.safetensors")}.part`)).toBe(true);

    await installer.remove();
    expect(existsSync(voiceDir)).toBe(false);
    expect(installer.status().setup).toEqual({ state: "not-set-up" });
  });

  test("is only offered on Apple silicon with macOS 14 or newer, unless e2e stands in for the engine", () => {
    expect(installerWith({ platform: { os: "darwin", cpu: "x64", darwinMajor: 25 } }).status().setup).toEqual({ state: "unsupported", reason: "Voice on this Mac needs a Mac with Apple silicon." });
    expect(installerWith({ platform: { os: "darwin", cpu: "arm64", darwinMajor: 22 } }).status().setup).toEqual({ state: "unsupported", reason: "Voice on this Mac needs macOS 14 or newer." });
    expect(installerWith({ platform: { os: "linux", cpu: "x64", darwinMajor: 6 }, fakePython: "/bin/true" }).status().setup).toEqual({ state: "not-set-up" });
  });
});
