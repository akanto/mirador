import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { PluginInfo, PluginSource } from "../../shared/apps.ts";
import { environmentWithoutPrompts } from "../git-environment.ts";
import { pluginFolders, type PluginLoadProblem } from "./plugins.ts";

/** Text that may hold a remote, as it may be shown: `https://user:token@host/…` loses its user and token. */
export const withoutCredentials = (text: string) => text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1");

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

/** The plugins folder, as the Plugins settings show it: every plugin in it, where it came from, and why one didn't load. */
export class InstalledPlugins {
  constructor(
    readonly folder: string,
    private readonly loadProblems: PluginLoadProblem[],
  ) {}

  async list(): Promise<PluginInfo[]> {
    return Promise.all(
      pluginFolders(this.folder).map(async (folder) => ({
        folder: basename(folder),
        ...(await manifestNames(folder)),
        source: await sourceOf(folder).catch((): PluginSource => ({ kind: "folder" })),
        problem: this.loadProblems.find((problem) => problem.folder === folder)?.message ?? null,
      })),
    );
  }
}
