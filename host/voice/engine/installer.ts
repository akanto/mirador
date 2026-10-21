import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, statfs, writeFile } from "node:fs/promises";
import { homedir, platform, arch, release, tmpdir } from "node:os";
import { join } from "node:path";
import { gigabytes, type VoiceEngineSetup, type VoiceEngineStatus, type VoiceEngineStep } from "../../../shared/voice-engine.ts";
import { isUnusedModelFile, modelFolderName, type EngineModel, type EngineModelId, type EngineSources } from "./catalog.ts";
import { bytesOnDisk, downloadFile, type Download } from "./downloads.ts";

/** Room left over once everything is in, so the Mac isn't left full. */
const SPARE_BYTES = 2e9;
/** uv, Python and the speech servers' packages, once installed. */
const INSTALLED_BYTES = 1.5e9;
/** What installing takes on top, for uv's cache of the packages while it installs them. */
const INSTALLING_BYTES = INSTALLED_BYTES + 1.5e9;
const PROGRESS_INTERVAL_MS = 250;
const MACOS_14_DARWIN_MAJOR = 23;

interface SetupRecord {
  uvSha256: string;
  pythonVersion: string;
  lockSha256: string;
  models: Partial<Record<EngineModelId, string>>;
}

interface TreeEntry {
  type: string;
  path: string;
  size: number;
  oid: string;
  lfs?: { oid: string };
}

export interface VoiceEngineInstallerOptions {
  voiceDir: string;
  logsDir: string;
  sources: EngineSources;
  /** e2e's stand-in for the engine's Python where there is no MLX: setup then only downloads the models. */
  fakePython: string | null;
  freeBytes?: (path: string) => Promise<number>;
  platform?: { os: string; cpu: string; darwinMajor: number };
  onChange: () => void;
}

const thisMachine = () => ({ os: platform(), cpu: arch(), darwinMajor: Number(release().split(".")[0]) });

const freeBytesOf = async (path: string) => {
  const { bavail, bsize } = await statfs(path);
  return bavail * bsize;
};

function unsupportedReason({ os, cpu, darwinMajor }: { os: string; cpu: string; darwinMajor: number }) {
  if (os !== "darwin" || cpu !== "arm64") return "Voice on this Mac needs a Mac with Apple silicon.";
  if (darwinMajor < MACOS_14_DARWIN_MAJOR) return "Voice on this Mac needs macOS 14 or newer.";
  return null;
}

const sha256Of = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");

const lastLine = (text: string) => text.trim().split("\n").at(-1) ?? "";

/** Downloads and installs Mirador's own speech engine into the data folder, and takes it away again. */
export class VoiceEngineInstaller {
  private setup: VoiceEngineSetup;
  private run: AbortController | null = null;
  private progressFlush: Timer | null = null;
  private readonly freeBytes: (path: string) => Promise<number>;

  constructor(private readonly options: VoiceEngineInstallerOptions) {
    this.freeBytes = options.freeBytes ?? freeBytesOf;
    const reason = options.fakePython ? null : unsupportedReason(options.platform ?? thisMachine());
    this.setup = reason ? { state: "unsupported", reason } : { state: "not-set-up" };
  }

  /** Reads what an earlier setup left, once at the host's start. */
  async load() {
    if (this.setup.state === "unsupported") return;
    const record = await this.record();
    if (!record || !(await this.isCurrent(record))) return;
    this.setup = { state: "set-up", withVoiceModel: record.models.voiceModel !== undefined, bytesOnDisk: await this.bytesOnDisk() };
    this.changed();
  }

  status(): VoiceEngineStatus {
    const { recognition, speech, voiceModel } = this.options.sources.models;
    return { setup: this.setup, diskBytes: { base: INSTALLED_BYTES + recognition.bytes + speech.bytes, voiceModel: voiceModel.bytes } };
  }

  /** Where a model's files are, once set up. */
  modelDir(id: EngineModelId) {
    return join(this.options.voiceDir, "models", modelFolderName(this.options.sources.models[id]));
  }

  get python() {
    return this.options.fakePython ?? join(this.options.voiceDir, "venv", "bin", "python");
  }

  setUp(withVoiceModel: boolean) {
    if (this.setup.state === "unsupported" || this.run) return;
    const run = new AbortController();
    this.run = run;
    const before = this.setup;
    this.install(withVoiceModel, run.signal)
      .then(async () => {
        this.setup = { state: "set-up", withVoiceModel, bytesOnDisk: await this.bytesOnDisk() };
      })
      .catch((error) => {
        this.setup = run.signal.aborted ? before : { state: "failed", withVoiceModel, problem: error instanceof Error ? error.message : String(error) };
      })
      .finally(() => {
        this.run = null;
        this.changed();
      });
  }

  cancel() {
    this.run?.abort();
  }

  async remove() {
    if (this.setup.state === "unsupported" || this.run) return;
    await rm(this.options.voiceDir, { recursive: true, force: true });
    this.setup = { state: "not-set-up" };
    this.changed();
  }

  private async install(withVoiceModel: boolean, signal: AbortSignal) {
    const models = this.wantedModels(withVoiceModel);
    this.progress(withVoiceModel, "space", 0, 0);
    const downloads = (await Promise.all(models.map(([id, model]) => this.downloadsOf(id, model, signal)))).flat();
    await this.checkSpace(downloads);
    if (!this.options.fakePython) {
      this.progress(withVoiceModel, "uv", 0, 0);
      await this.installUv(signal);
      this.progress(withVoiceModel, "python", 0, 0);
      await this.uv(["python", "install", this.options.sources.pythonVersion, "--no-bin"], signal);
      this.progress(withVoiceModel, "packages", 0, 0);
      await this.installPackages(signal);
    }
    await this.downloadModels(withVoiceModel, downloads, signal);
    await this.writeRecord(models);
  }

  private wantedModels(withVoiceModel: boolean) {
    const { recognition, speech, voiceModel } = this.options.sources.models;
    const base: [EngineModelId, EngineModel][] = [
      ["recognition", recognition],
      ["speech", speech],
    ];
    return withVoiceModel ? [...base, ["voiceModel", voiceModel] as [EngineModelId, EngineModel]] : base;
  }

  private async downloadsOf(id: EngineModelId, { repo, revision }: EngineModel, signal: AbortSignal): Promise<Download[]> {
    const { modelsUrl } = this.options.sources;
    const response = await fetch(`${modelsUrl}/api/models/${repo}/tree/${revision}?recursive=true`, { signal });
    if (!response.ok) throw new Error(`${new URL(modelsUrl).host} answered ${response.status} when asked for the files of ${repo}.`);
    const entries = (await response.json()) as TreeEntry[];
    return entries
      .filter(({ type, path }) => type === "file" && !isUnusedModelFile(path))
      .map(({ path, size, oid, lfs }) => ({
        url: `${modelsUrl}/${repo}/resolve/${revision}/${path.split("/").map(encodeURIComponent).join("/")}`,
        destination: join(this.modelDir(id), path),
        size,
        checksum: lfs ? { sha256: lfs.oid } : { gitBlobSha1: oid },
      }));
  }

  private async checkSpace(downloads: Download[]) {
    const onDisk = await Promise.all(downloads.map(bytesOnDisk));
    const stillToDownload = downloads.reduce((sum, { size }, index) => sum + size - onDisk[index]!, 0);
    const installing = this.options.fakePython || (await this.packagesInstalled()) ? 0 : INSTALLING_BYTES;
    const needed = stillToDownload + installing + SPARE_BYTES;
    await mkdir(this.options.voiceDir, { recursive: true });
    const free = await this.freeBytes(this.options.voiceDir);
    if (free < needed) throw new Error(`Setting up needs ${gigabytes(needed)} free, and this Mac has ${gigabytes(free)}.`);
  }

  private async installUv(signal: AbortSignal) {
    const binDir = join(this.options.voiceDir, "bin");
    const marker = join(binDir, "uv.sha256");
    const { url, sha256 } = this.options.sources.uv;
    if ((await readFile(marker, "utf8").catch(() => "")) === sha256) return;
    const archive = join(binDir, "uv.tar.gz");
    const download = { url, destination: archive, size: await this.sizeAt(url, signal), checksum: { sha256 } };
    await downloadFile(download, signal, () => {});
    await this.command(["tar", "-xzf", archive, "-C", binDir, "--strip-components", "1"], signal);
    await rm(archive);
    await writeFile(marker, sha256);
  }

  private async sizeAt(url: string, signal: AbortSignal) {
    const response = await fetch(url, { method: "HEAD", signal });
    const size = Number(response.headers.get("content-length"));
    if (!response.ok || !size) throw new Error(`${new URL(url).host} answered ${response.status} for ${url}.`);
    return size;
  }

  private async installPackages(signal: AbortSignal) {
    if (await this.packagesInstalled()) return;
    const venv = join(this.options.voiceDir, "venv");
    await this.uv(["venv", "--python", this.options.sources.pythonVersion, "--managed-python", "--clear", venv], signal);
    await this.uv(["pip", "install", "--require-hashes", "-r", this.options.sources.lockFile, "--python", join(venv, "bin", "python")], signal);
    await writeFile(join(venv, "mirador-lock.sha256"), await sha256Of(this.options.sources.lockFile));
    await rm(join(this.options.voiceDir, "uv-cache"), { recursive: true, force: true });
  }

  private async packagesInstalled() {
    const installed = await readFile(join(this.options.voiceDir, "venv", "mirador-lock.sha256"), "utf8").catch(() => null);
    return installed === (await sha256Of(this.options.sources.lockFile));
  }

  private async downloadModels(withVoiceModel: boolean, downloads: Download[], signal: AbortSignal) {
    const onDisk = await Promise.all(downloads.map(bytesOnDisk));
    const total = downloads.reduce((sum, { size }) => sum + size, 0);
    const done = () => onDisk.reduce((sum, bytes) => sum + bytes, 0);
    this.progress(withVoiceModel, "models", done(), total);
    for (const [index, download] of downloads.entries()) {
      await downloadFile(download, signal, (bytes) => {
        onDisk[index] = bytes;
        this.progress(withVoiceModel, "models", done(), total);
      });
    }
  }

  /** uv kept to the voice folder: its own Python, cache and no user configuration. */
  private uv(args: string[], signal: AbortSignal) {
    return this.command([join(this.options.voiceDir, "bin", "uv"), ...args, "--no-config"], signal, {
      UV_CACHE_DIR: join(this.options.voiceDir, "uv-cache"),
      UV_PYTHON_INSTALL_DIR: join(this.options.voiceDir, "python"),
      UV_NO_PROGRESS: "1",
    });
  }

  private async command(command: string[], signal: AbortSignal, environment: Record<string, string> = {}) {
    await mkdir(this.options.logsDir, { recursive: true });
    const log = createWriteStream(join(this.options.logsDir, "voice-setup.log"), { flags: "a" });
    log.write(`${new Date().toISOString()} ${command.join(" ")}\n`);
    const child = Bun.spawn(command, {
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: homedir(), TMPDIR: tmpdir(), ...environment },
      stdout: "pipe",
      stderr: "pipe",
      signal,
    });
    const [output, errors, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    log.end(output + errors);
    signal.throwIfAborted();
    if (exitCode !== 0) throw new Error(`${command[0]!.split("/").at(-1)} ${command[1]} failed: ${lastLine(errors) || `exit code ${exitCode}`}`);
  }

  private recordPath() {
    return join(this.options.voiceDir, "setup.json");
  }

  private async record() {
    return JSON.parse(await readFile(this.recordPath(), "utf8").catch(() => "null")) as SetupRecord | null;
  }

  private async writeRecord(models: [EngineModelId, EngineModel][]) {
    const record: SetupRecord = {
      uvSha256: this.options.sources.uv.sha256,
      pythonVersion: this.options.sources.pythonVersion,
      lockSha256: await sha256Of(this.options.sources.lockFile),
      models: Object.fromEntries(models.map(([id, { revision }]) => [id, revision])),
    };
    await writeFile(this.recordPath(), JSON.stringify(record, null, 2));
  }

  /** Set up by this version of Mirador: a newer one may pin other packages or models, which setting up again brings in. */
  private async isCurrent(record: SetupRecord) {
    const { sources } = this.options;
    const modelsCurrent = Object.entries(record.models).every(([id, revision]) => sources.models[id as EngineModelId]?.revision === revision);
    if (!modelsCurrent || record.models.recognition === undefined || record.models.speech === undefined) return false;
    if (this.options.fakePython) return true;
    return record.uvSha256 === sources.uv.sha256 && record.pythonVersion === sources.pythonVersion && record.lockSha256 === (await sha256Of(sources.lockFile));
  }

  private async bytesOnDisk() {
    const child = Bun.spawn(["du", "-sk", this.options.voiceDir], { stdout: "pipe", stderr: "ignore" });
    const kilobytes = Number((await new Response(child.stdout).text()).split(/\s/)[0]);
    return Number.isFinite(kilobytes) ? kilobytes * 1024 : 0;
  }

  /** Sent at most every quarter second, as a download reports every chunk. */
  private progress(withVoiceModel: boolean, step: VoiceEngineStep, done: number, total: number) {
    const stepChanged = this.setup.state !== "setting-up" || this.setup.step !== step;
    this.setup = { state: "setting-up", withVoiceModel, step, done, total };
    if (stepChanged) return this.changed();
    this.progressFlush ??= setTimeout(() => this.changed(), PROGRESS_INTERVAL_MS);
  }

  private changed() {
    if (this.progressFlush) clearTimeout(this.progressFlush);
    this.progressFlush = null;
    this.options.onChange();
  }
}
