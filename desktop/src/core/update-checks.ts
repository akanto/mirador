import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

/** Electrobun 2.0.2 keeps each build's archive, and the note of the one prepared to install, here in the channel's folder. */
const EXTRACTION_FOLDER = "self-extraction";
const PREPARED_UPDATE_NOTE = ".electrobun-prepared-update.json";
const SKIPPED_BUILDS_FILE = "mirador-skipped-updates.json";

/** `codesign -dv` names the team on stderr; an app signed ad hoc, or not at all, has none. */
export function teamIdentifierIn(codesignDetails: string) {
  const team = /^TeamIdentifier=(.+)$/m.exec(codesignDetails)?.[1]?.trim();
  return team && team !== "not set" ? team : null;
}

const run = promisify(execFile);
const succeeds = (command: string, args: string[]) => run(command, args).then(() => true, () => false);

/** Asynchronous, like every check here, as they run in the app's main process, which also answers the tray and the window. */
async function codesignDetails(app: string) {
  try {
    return (await run("codesign", ["-dv", app])).stderr;
  } catch (error) {
    return String((error as { stderr?: unknown }).stderr ?? "");
  }
}

export const teamIdentifierOf = async (app: string) => teamIdentifierIn(await codesignDetails(app));

/** What an update replaces: the app bundle on macOS, the `app` folder that holds the launcher on Linux. */
export const replacedFolder = (appPath: string, platform: NodeJS.Platform) => (platform === "darwin" ? appPath : dirname(dirname(appPath)));

/** macOS runs a quarantined app opened where it was downloaded from a read-only copy, which cannot be replaced. */
const isTranslocated = (folder: string) => folder.includes("/AppTranslocation/");

function canWrite(folder: string) {
  try {
    accessSync(folder, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Why the app cannot swap in a new build where it is, said as the step that fixes it; null when it can. */
export function updateBlockedBy(folder: string, platform: NodeJS.Platform, writable: (folder: string) => boolean = canWrite) {
  if (platform === "darwin" && isTranslocated(folder)) return "move Mirador to Applications to update it";
  if (!writable(dirname(folder))) return `Mirador cannot replace itself in ${dirname(folder)}`;
  return null;
}

/** The running build's archive stays: it is what the next patch applies to. */
export function discardDownload(channelFolder: string, hash: string) {
  rmSync(join(channelFolder, EXTRACTION_FOLDER, `${hash}.tar`), { force: true });
  rmSync(join(channelFolder, EXTRACTION_FOLDER, PREPARED_UPDATE_NOTE), { force: true });
}

export const downloadedArchive = (channelFolder: string, hash: string) => join(channelFolder, EXTRACTION_FOLDER, `${hash}.tar`);

export function skippedBuilds(channelFolder: string) {
  const file = join(channelFolder, SKIPPED_BUILDS_FILE);
  const read = (): string[] => {
    try {
      const stored = JSON.parse(readFileSync(file, "utf8"));
      return Array.isArray(stored) ? stored.filter((hash) => typeof hash === "string") : [];
    } catch {
      return [];
    }
  };
  return {
    has: (hash: string) => read().includes(hash),
    add: (hash: string) => writeFileSync(file, JSON.stringify([...new Set([...read(), hash])])),
  };
}

/** A valid signature, from the same team as the running app; an app with no team on either side fails. */
export async function signedBySameTeam(archive: string, runningApp: string) {
  const runningTeam = await teamIdentifierOf(runningApp);
  if (!runningTeam || !existsSync(archive)) return false;
  const folder = await mkdtemp(join(tmpdir(), "mirador-update-check-"));
  try {
    if (!(await succeeds("tar", ["-xf", archive, "-C", folder]))) return false;
    const app = (await readdir(folder)).find((name) => name.endsWith(".app"));
    if (!app) return false;
    const verified = await succeeds("codesign", ["--verify", "--strict", "--deep", join(folder, app)]);
    return verified && (await teamIdentifierOf(join(folder, app))) === runningTeam;
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
