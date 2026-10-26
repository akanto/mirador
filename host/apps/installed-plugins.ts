import { existsSync, lstatSync, mkdirSync, readlinkSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { isPluginVersion, type PluginManifest, type PluginNews, type PluginInfo, type PluginSource, type PluginUpdate } from "../../shared/apps.ts";
import { isNewerVersion } from "../../shared/newer-version.ts";
import { environmentWithoutPrompts } from "../git-environment.ts";
import { AppProblem, messageOf, pluginFiles, pluginFolders, readManifest, refuseUnversioned, type PluginLoadProblem } from "./plugins.ts";

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

const RELEASE_TAG_PREFIX = "v";
const releaseTag = (version: string) => `${RELEASE_TAG_PREFIX}${version}`;
const releaseOfTag = (tag: string | null) => {
  const version = tag?.startsWith(RELEASE_TAG_PREFIX) ? tag.slice(RELEASE_TAG_PREFIX.length) : null;
  return isPluginVersion(version) ? version : null;
};

const newestOf = (tags: string[]) =>
  tags.flatMap((tag) => releaseOfTag(tag) ?? []).reduce<string | null>((newest, release) => (newest === null || isNewerVersion(release, newest) ? release : newest), null);

/** The newest release whose tag a detached checkout sits at; a checkout of a branch follows the branch. */
async function releaseCheckedOut(folder: string) {
  return newestOf(((await gitOutput(folder, ["tag", "--points-at", "HEAD", "--list", `${RELEASE_TAG_PREFIX}[0-9]*`])) ?? "").split("\n"));
}

/** The newest release the repo has tagged; null when it tags none. */
async function newestRelease(url: string): Promise<string | null> {
  const listed = await run(["git", "ls-remote", "--tags", "--refs", "--", url, `${RELEASE_TAG_PREFIX}*`], process.cwd(), environmentWithoutPrompts(), GIT_GIVES_UP_AFTER_MS);
  if (!listed.ok) throw new AppProblem(`git ls-remote failed:\n${listed.output}`);
  return newestOf(listed.output.split("\n").map((line) => line.split("refs/tags/")[1] ?? ""));
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
  const release = branch ? null : await releaseCheckedOut(folder);
  return { kind: "git", remote: remote && withoutCredentials(remote), branch, release, commit, subject: subject ?? "" };
}

/** What plugin.json says, as far as it can be read, for a plugin that may not load. */
async function manifestFields(folder: string): Promise<{ name: string | null; title: string | null; version: string | null }> {
  const textOrNull = (value: unknown) => (typeof value === "string" ? value : null);
  try {
    const { name, title, version } = await Bun.file(join(folder, "plugin.json")).json();
    return { name: textOrNull(name), title: textOrNull(title), version: textOrNull(version) };
  } catch {
    return { name: null, title: null, version: null };
  }
}

const isLink = (folder: string) => lstatSync(folder).isSymbolicLink();

const byTitle = ({ title, folder }: PluginInfo) => title ?? folder;

/**
 * The plugins folder: what the Plugins settings list, and the plugins they add from a git repo, update and remove. A change takes effect at Mirador's next start, which is when plugins load.
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
    const plugins = await Promise.all(pluginFolders(this.folder).map(async (folder) => this.info(folder, await sourceOf(folder).catch((): PluginSource => ({ kind: "folder" })))));
    return plugins.sort((one, other) => byTitle(one).localeCompare(byTitle(other)));
  }

  private async info(folder: string, source: PluginSource): Promise<PluginInfo> {
    return {
      folder: basename(folder),
      ...(await manifestFields(folder)),
      source,
      problem: this.loadProblems.find((problem) => problem.folder === folder)?.message ?? null,
      waitsForRestart: this.changed.has(basename(folder)),
    };
  }

  /**
   * Clones the repo at the branch or tag given, or else at its newest release, or its default branch when it tags no
   * release; builds it and puts it in the plugins folder, in a folder named as the plugin.
   */
  add(url: string, branch: string | null): Promise<void> {
    return this.oneAtATime(async () => {
      const repo = expandedHome(url.trim());
      const given = branch?.trim() || null;
      const release = given || !repo ? null : await newestRelease(repo);
      const { staged, manifest } = await this.clonedAndBuilt(repo, given ?? (release && releaseTag(release)));
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

  /** What updating would bring: the newer release, or the commits on the plugin's branch it doesn't have yet. */
  news(folderName: string): Promise<PluginNews> {
    return this.oneAtATime(async () => {
      const folder = this.clonedPlugin(folderName);
      const followed = await this.followed(folder);
      if (followed.branch === null) {
        const newest = await newestRelease(followed.remote);
        if (!newest || !isNewerVersion(newest, followed.release)) return { release: null, commits: [] };
        return { release: newest, commits: await this.commitsOf(folder, `refs/tags/${releaseTag(newest)}`) };
      }
      return { release: null, commits: await this.commitsOf(folder, followed.branch) };
    });
  }

  /** The commits the ref brings that the checkout doesn't have, newest first. */
  private async commitsOf(folder: string, ref: string) {
    const fetched = await run(["git", "fetch", "--quiet", "--no-tags", "origin", ref], folder, environmentWithoutPrompts(), GIT_GIVES_UP_AFTER_MS);
    if (!fetched.ok) throw new AppProblem(`git fetch failed:\n${fetched.output}`);
    const log = (await gitOutput(folder, ["log", "--format=%h%x09%s", "HEAD..FETCH_HEAD"])) ?? "";
    return log
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [commit = "", ...subject] = line.split("\t");
        return { commit, subject: subject.join("\t") };
      });
  }

  /** The plugins from git repos with news; one whose fetch fails, offline for one, keeps what was last found for it. */
  async updatesFound(last: PluginUpdate[] | null): Promise<PluginUpdate[]> {
    const fromGit = (await this.list()).flatMap(({ folder, title, source }) => (source.kind === "git" ? [{ folder, title, from: source.commit }] : []));
    const found = await Promise.all(
      fromGit.map(async ({ folder, title, from }) => {
        try {
          return { folder, title: title ?? folder, from, ...(await this.news(folder)) };
        } catch {
          return last?.find((update) => update.folder === folder) ?? null;
        }
      }),
    );
    return found.filter((update): update is PluginUpdate => update !== null && (update.release !== null || update.commits.length > 0));
  }

  /**
   * Clones and builds the newest release, or the branch as it is now, and only then swaps it in, so a failed update
   * leaves the plugin as it was.
   */
  update(folderName: string): Promise<void> {
    return this.oneAtATime(async () => {
      const folder = this.clonedPlugin(folderName);
      const followed = await this.followed(folder);
      const newest = followed.release && ((await newestRelease(followed.remote)) ?? followed.release);
      const installed = await readManifest(folder).catch(() => null);
      const { staged, manifest } = await this.clonedAndBuilt(followed.remote, newest ? releaseTag(newest) : followed.branch);
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
      const { name } = await manifestFields(folder);
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

  /** Clones the repo at the branch or tag, or its default branch, and builds it in the staging folder. */
  private async clonedAndBuilt(url: string, branchOrTag: string | null): Promise<{ staged: string; manifest: PluginManifest }> {
    if (!url) throw new AppProblem("Give the git URL or the path of the plugin's repo.");
    mkdirSync(this.staging, { recursive: true });
    const staged = join(this.staging, crypto.randomUUID());
    try {
      const cloned = await run(
        ["git", "clone", "--quiet", WITH_FILES_AS_COMMITTED, ...(branchOrTag ? [`--branch=${branchOrTag}`] : []), "--", url, staged],
        this.staging,
        environmentWithoutPrompts(),
        GIT_GIVES_UP_AFTER_MS,
      );
      if (!cloned.ok) throw new AppProblem(`git clone failed:\n${cloned.output}`);
      const manifest = await readManifest(staged)
        .then((read) => (refuseUnversioned(read), read))
        .catch((error) => {
          throw new AppProblem(`The repo isn't a plugin Mirador can load: ${messageOf(error)}.`);
        });
      const tagged = releaseOfTag(branchOrTag);
      if (tagged && manifest.version !== tagged) throw new AppProblem(`Its tag ${branchOrTag} is release ${tagged}, but its plugin.json says version ${manifest.version}.`);
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
      if ((await manifestFields(folder)).name === name) throw new AppProblem(`The plugin in ${basename(folder)} is already named ${name}; remove it first.`);
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

  /** Where updates come from: the remote's releases, for a clone at a release's tag, or else its branch. */
  private async followed(folder: string): Promise<{ remote: string; branch: string; release: null } | { remote: string; branch: null; release: string }> {
    const [remote, branch] = await Promise.all([gitOutput(folder, ["remote", "get-url", "origin"]), gitOutput(folder, ["symbolic-ref", "--quiet", "--short", "HEAD"])]);
    if (remote && branch) return { remote, branch, release: null };
    const release = remote && (await releaseCheckedOut(folder));
    if (!remote || !release) throw new AppProblem(`${basename(folder)} has no remote branch or release to update from.`);
    return { remote, branch: null, release };
  }
}
