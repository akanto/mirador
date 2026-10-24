import { existsSync, lstatSync, mkdirSync, readlinkSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import type { AppManifest, PluginCommit, PluginInfo, PluginSource } from "../../shared/apps.ts";
import { environmentWithoutPrompts } from "../git-environment.ts";
import { AppProblem, messageOf, pluginFiles, pluginFolders, readManifest, type PluginLoadProblem } from "./plugins.ts";

const GIT_GIVES_UP_AFTER_MS = 5 * 60_000;
const BUILD_GIVES_UP_AFTER_MS = 10 * 60_000;
/** The end of a failed build's output is where its error is. */
const OUTPUT_SHOWN_CHARACTERS = 4000;
/** A plugin's files install as committed, on every OS: Git for Windows checks text out with CRLF by default. */
const WITH_FILES_AS_COMMITTED = "--config=core.autocrlf=false";

/** Text that may hold a remote, as it may be shown: `https://user:token@host/…` loses its user and token. */
export const withoutCredentials = (text: string) => text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1");

const lastPart = (output: string) => (output.length > OUTPUT_SHOWN_CHARACTERS ? `…${output.slice(-OUTPUT_SHOWN_CHARACTERS)}` : output);

/** Its output, or null when git fails or isn't installed. */
async function gitOutput(folder: string, args: string[]): Promise<string | null> {
  try {
    const child = Bun.spawn(["git", "-C", folder, ...args], { env: environmentWithoutPrompts(), stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const [output, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return exitCode === 0 ? output.trim() : null;
  } catch {
    return null;
  }
}

/** Runs a command to its end; its output, stdout and stderr together, never shows credentials. */
async function run(command: string[], cwd: string, env: Record<string, string | undefined>, givesUpAfterMs: number): Promise<{ ok: boolean; output: string }> {
  try {
    const child = Bun.spawn(command, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: givesUpAfterMs });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const output = withoutCredentials(`${stdout}${stderr}`.trim());
    const stopped = child.signalCode ? `\n(stopped after ${givesUpAfterMs / 60_000} minutes)` : "";
    return { ok: exitCode === 0, output: output + stopped };
  } catch (error) {
    return { ok: false, output: withoutCredentials(messageOf(error)) };
  }
}

/** git leaves `~` to the shell, and a path typed into Settings has none. */
const expandedHome = (url: string) => (url === "~" || url.startsWith("~/") ? join(homedir(), url.slice(1)) : url);

const shellCommand = (command: string) => (process.platform === "win32" ? ["cmd", "/d", "/s", "/c", command] : ["sh", "-c", command]);

/** A build finds `bun` even where Mirador was started without it on the PATH, as the desktop app is. */
function buildEnvironment() {
  const environment: Record<string, string | undefined> = environmentWithoutPrompts();
  const pathKey = Object.keys(environment).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  return { ...environment, [pathKey]: [dirname(process.execPath), environment[pathKey]].filter(Boolean).join(delimiter) };
}

async function sourceOf(folder: string): Promise<PluginSource> {
  if (lstatSync(folder).isSymbolicLink()) return { kind: "linked", target: resolve(dirname(folder), readlinkSync(folder)) };
  if (!existsSync(join(folder, ".git"))) return { kind: "folder" };
  const [remote, branch, commit, subject] = await Promise.all([
    gitOutput(folder, ["remote", "get-url", "origin"]),
    gitOutput(folder, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    gitOutput(folder, ["rev-parse", "--short", "HEAD"]),
    gitOutput(folder, ["log", "-1", "--format=%s"]),
  ]);
  if (!commit) return { kind: "folder" };
  return { kind: "git", remote: remote && withoutCredentials(remote), branch, commit, subject: subject ?? "" };
}

async function manifestNames(folder: string): Promise<{ name: string | null; title: string | null }> {
  try {
    const { name, title } = await Bun.file(join(folder, "plugin.json")).json();
    return { name: typeof name === "string" ? name : null, title: typeof title === "string" ? title : null };
  } catch {
    return { name: null, title: null };
  }
}

const isLink = (folder: string) => lstatSync(folder).isSymbolicLink();

/**
 * The plugins folder: what the Plugins settings list, and the plugins they add from a git repo, update and remove. A
 * change takes effect at Mirador's next start, which is when plugins load.
 */
export class InstalledPlugins {
  /**
   * Where a repo is cloned and built before it moves into the plugins folder, and where a replaced or removed plugin
   * waits, since the running host still holds its code; the next start empties it.
   */
  private readonly staging: string;
  private readonly changed = new Set<string>();
  private lastChange: Promise<unknown> = Promise.resolve();

  constructor(
    readonly folder: string,
    private readonly loadProblems: PluginLoadProblem[],
  ) {
    this.staging = `${folder}-staging`;
    rmSync(this.staging, { recursive: true, force: true });
  }

  get restartNeeded() {
    return this.changed.size > 0;
  }

  async list(): Promise<PluginInfo[]> {
    return Promise.all(
      pluginFolders(this.folder).map(async (folder) => ({
        folder: basename(folder),
        ...(await manifestNames(folder)),
        source: await sourceOf(folder).catch((): PluginSource => ({ kind: "folder" })),
        problem: this.loadProblems.find((problem) => problem.folder === folder)?.message ?? null,
        waitsForRestart: this.changed.has(basename(folder)),
      })),
    );
  }

  /** Clones the repo, builds it and puts it in the plugins folder, in a folder named as the plugin. */
  add(url: string, branch: string | null): Promise<void> {
    return this.oneAtATime(async () => {
      const { staged, manifest } = await this.clonedAndBuilt(expandedHome(url.trim()), branch?.trim() || null);
      try {
        await this.refuseTakenName(manifest.name);
        mkdirSync(this.folder, { recursive: true });
        renameSync(staged, join(this.folder, manifest.name));
        this.changed.add(manifest.name);
      } finally {
        rmSync(staged, { recursive: true, force: true });
      }
    });
  }

  /** Fetches the plugin's branch: the commits it doesn't have yet, newest first. */
  newCommits(folderName: string): Promise<PluginCommit[]> {
    return this.oneAtATime(async () => {
      const folder = this.clonedPlugin(folderName);
      const { branch } = await this.remoteBranch(folder);
      const fetched = await run(["git", "fetch", "--quiet", "--no-tags", "origin", branch], folder, environmentWithoutPrompts(), GIT_GIVES_UP_AFTER_MS);
      if (!fetched.ok) throw new AppProblem(`git fetch failed:\n${fetched.output}`);
      const log = (await gitOutput(folder, ["log", "--format=%h%x09%s", "HEAD..FETCH_HEAD"])) ?? "";
      return log
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [commit = "", ...subject] = line.split("\t");
          return { commit, subject: subject.join("\t") };
        });
    });
  }

  /** Clones and builds the branch as it is now, and only then swaps it in, so a failed update leaves the plugin as it was. */
  update(folderName: string): Promise<void> {
    return this.oneAtATime(async () => {
      const folder = this.clonedPlugin(folderName);
      const { remote, branch } = await this.remoteBranch(folder);
      const installed = await readManifest(folder).catch(() => null);
      const { staged, manifest } = await this.clonedAndBuilt(remote, branch);
      try {
        if (installed && manifest.name !== installed.name) {
          throw new AppProblem(`The repo's plugin is named ${manifest.name} now, not ${installed.name}; remove ${folderName} and add the repo again.`);
        }
        renameSync(folder, join(this.staging, `${folderName}-replaced-${crypto.randomUUID()}`));
        renameSync(staged, folder);
        this.changed.add(folderName);
      } finally {
        rmSync(staged, { recursive: true, force: true });
      }
    });
  }

  /** Takes the plugin out of the plugins folder; a link goes, the folder it points to stays. The plugin's name, for forgetting where its app was open. */
  remove(folderName: string): Promise<string | null> {
    return this.oneAtATime(async () => {
      const folder = this.installedFolder(folderName);
      const { name } = await manifestNames(folder);
      if (isLink(folder)) {
        unlinkSync(folder);
      } else {
        mkdirSync(this.staging, { recursive: true });
        renameSync(folder, join(this.staging, `${folderName}-removed-${crypto.randomUUID()}`));
      }
      this.changed.add(folderName);
      return name;
    });
  }

  private oneAtATime<T>(change: () => Promise<T>): Promise<T> {
    const done = this.lastChange.then(change);
    this.lastChange = done.catch(() => {});
    return done;
  }

  private async clonedAndBuilt(url: string, branch: string | null): Promise<{ staged: string; manifest: AppManifest }> {
    if (!url) throw new AppProblem("Give the git URL or the path of the plugin's repo.");
    mkdirSync(this.staging, { recursive: true });
    const staged = join(this.staging, crypto.randomUUID());
    try {
      const cloned = await run(
        ["git", "clone", "--quiet", WITH_FILES_AS_COMMITTED, ...(branch ? [`--branch=${branch}`] : []), "--", url, staged],
        this.staging,
        environmentWithoutPrompts(),
        GIT_GIVES_UP_AFTER_MS,
      );
      if (!cloned.ok) throw new AppProblem(`git clone failed:\n${cloned.output}`);
      const manifest = await readManifest(staged).catch((error) => {
        throw new AppProblem(`The repo isn't a plugin Mirador can load: ${messageOf(error)}.`);
      });
      if (manifest.build) {
        const built = await run(shellCommand(manifest.build), staged, buildEnvironment(), BUILD_GIVES_UP_AFTER_MS);
        if (!built.ok) throw new AppProblem(`Its build command, ${manifest.build}, failed:\n${lastPart(built.output)}`);
      }
      try {
        pluginFiles(staged, manifest);
      } catch (error) {
        throw new AppProblem(`After ${manifest.build ? "its build" : "cloning"}, ${messageOf(error)}.`);
      }
      return { staged, manifest };
    } catch (error) {
      rmSync(staged, { recursive: true, force: true });
      throw error instanceof AppProblem ? new AppProblem(withoutCredentials(error.message)) : new AppProblem(withoutCredentials(messageOf(error)));
    }
  }

  private async refuseTakenName(name: string) {
    if (existsSync(join(this.folder, name))) throw new AppProblem(`The plugins folder already has a ${name} folder; update or remove that plugin first.`);
    for (const folder of pluginFolders(this.folder)) {
      if ((await manifestNames(folder)).name === name) throw new AppProblem(`The plugin in ${basename(folder)} is already named ${name}; remove it first.`);
    }
  }

  private installedFolder(folderName: string) {
    const folder = pluginFolders(this.folder).find((each) => basename(each) === folderName);
    if (!folder) throw new AppProblem(`No plugin is installed in ${folderName}.`);
    return folder;
  }

  private clonedPlugin(folderName: string) {
    const folder = this.installedFolder(folderName);
    if (isLink(folder) || !existsSync(join(folder, ".git"))) throw new AppProblem(`${folderName} wasn't installed from a git repo, so there's nothing to update it from.`);
    return folder;
  }

  private async remoteBranch(folder: string) {
    const [remote, branch] = await Promise.all([gitOutput(folder, ["remote", "get-url", "origin"]), gitOutput(folder, ["symbolic-ref", "--quiet", "--short", "HEAD"])]);
    if (!remote || !branch) throw new AppProblem(`${basename(folder)} has no remote branch to update from.`);
    return { remote, branch };
  }
}
