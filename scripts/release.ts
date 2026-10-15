#!/usr/bin/env bun
/**
 * Makes a release, as the Makefile's release goals run it:
 *   release <version> [from-step]  bumps the version, gates, builds, signs and checks every app, and leaves a checked
 *                                  draft on GitHub with the notes in dist/release-notes-<version>.md
 *   publish <version>              publishes that draft as the latest release
 *   tap <version>                  pushes the Homebrew cask of the published release to the tap
 * The release is made in a worktree of its own at origin/main, so nothing uncommitted in this checkout reaches it, and
 * into dist/<version>/. A step that fails names the step to go on from once it is fixed.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CASK_ASSETS } from "../desktop/scripts/homebrew-cask.ts";
import { isNewerVersion, RELEASES_REPOSITORY } from "../shared/newer-version.ts";

const CHECKOUT = join(import.meta.dir, "..");
const VERSION_FILE = join("shared", "version.ts");
const RELEASE_ASSET = /^(Mirador-|stable-)|^install\.sh$/;
const CHECKSUMS_HEADING = "## Checksums (SHA-256)";
const PLATFORMS = ["macos-arm64", "linux-x64", "linux-arm64"];
const REQUIRED_ASSETS = [...Object.values(CASK_ASSETS), "install.sh", ...PLATFORMS.map((platform) => `stable-${platform}-update.json`)];
const BUILD_LINE = "== release of ";

export interface Release {
  version: string;
  tag: string;
  worktree: string;
  dist: string;
  notes: string;
}

export function releaseOf(version: string, checkout = CHECKOUT, temporary = tmpdir()): Release {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Name the release as x.y.z, not "${version}"`);
  return {
    version,
    tag: `v${version}`,
    worktree: join(temporary, `mirador-release-${version}`),
    dist: join(checkout, "dist", version),
    notes: join(checkout, "dist", `release-notes-${version}.md`),
  };
}

/** The notes as approved, with the checksums of what the release holds in place of any the notes had. */
export function notesWithChecksums(notes: string, checksums: string) {
  const withoutChecksums = notes.split(`\n${CHECKSUMS_HEADING}`)[0]!.trimEnd();
  return `${withoutChecksums}\n\n${CHECKSUMS_HEADING}\n\n\`\`\`\n${checksums.trim()}\n\`\`\`\n`;
}

export const releaseAssets = (files: string[]) => files.filter((file) => RELEASE_ASSET.test(file)).sort();

export const missingAssets = (files: string[]) => REQUIRED_ASSETS.filter((asset) => !files.includes(asset));

/** `git describe` shortens the commit to as few digits as its clone needs, so the build machine's may be shorter or longer. */
export function isBuildOf(buildLine: string, commit: string) {
  const abbreviated = buildLine.slice(BUILD_LINE.length).trim().match(/^(?:.*-g)?([0-9a-f]{4,40})$/)?.[1];
  return abbreviated !== undefined && commit.startsWith(abbreviated);
}

/** The assets GitHub holds whose digest differs from the file that was uploaded, or that never arrived. */
export function digestMismatches(local: Record<string, string>, uploaded: Record<string, string>) {
  return Object.entries(local)
    .filter(([asset, sha256]) => uploaded[asset] !== `sha256:${sha256}`)
    .map(([asset]) => asset);
}

/** The cask's assets whose published SHA-256 the cask does not name. */
export function caskMismatches(cask: string, uploaded: Record<string, string>) {
  return Object.values(CASK_ASSETS).filter((asset) => {
    const sha256 = uploaded[asset]?.replace(/^sha256:/, "");
    return !sha256 || !cask.includes(`"${sha256}"`);
  });
}

export function stepsFrom<Step extends { name: string }>(steps: Step[], from: string | undefined) {
  if (!from) return steps;
  const start = steps.findIndex((step) => step.name === from);
  if (start === -1) throw new Error(`There is no step "${from}"; the steps are ${steps.map((step) => step.name).join(", ")}`);
  return steps.slice(start);
}

function run(command: string[], cwd: string, env: Record<string, string | undefined> = process.env) {
  console.log(`$ ${command.join(" ")}`);
  const { exitCode } = Bun.spawnSync(command, { cwd, env, stdio: ["inherit", "inherit", "inherit"] });
  if (exitCode !== 0) throw new Error(`${command.join(" ")} failed with exit code ${exitCode}`);
}

/** Shows what the command prints as it goes, and gives it back. */
async function runAndRead(command: string[], cwd: string) {
  console.log(`$ ${command.join(" ")}`);
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "inherit" });
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  for await (const chunk of child.stdout) {
    process.stdout.write(chunk);
    chunks.push(decoder.decode(chunk, { stream: true }));
  }
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${command.join(" ")} failed with exit code ${exitCode}`);
  return chunks.join("");
}

function read(command: string[], cwd = CHECKOUT) {
  const { exitCode, stdout, stderr } = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
  if (exitCode !== 0) throw new Error(`${command.join(" ")} failed: ${stderr.toString().trim()}`);
  return stdout.toString().trim();
}

const sha256Of = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const headOf = (release: Release) => read(["git", "rev-parse", "HEAD"], release.worktree);
const versionIn = (folder: string) => readFileSync(join(folder, VERSION_FILE), "utf8").match(/MIRADOR_VERSION = "([^"]+)"/)![1]!;

const releasesNamed = (release: Release) => read(["gh", "api", `repos/${RELEASES_REPOSITORY}/releases`, "--jq", `.[] | select(.tag_name=="${release.tag}") | .id`]);

function uploadedDigests(release: Release) {
  const listing = read(["gh", "api", `repos/${RELEASES_REPOSITORY}/releases`, "--jq", `.[] | select(.tag_name=="${release.tag}") | .assets[] | "\\(.name) \\(.digest)"`]);
  return Object.fromEntries(listing.split("\n").filter(Boolean).map((line) => line.split(" ") as [string, string]));
}

function makeWorktree(release: Release) {
  run(["git", "fetch", "-q", "origin"], CHECKOUT);
  if (existsSync(release.worktree)) run(["git", "worktree", "remove", "--force", release.worktree], CHECKOUT);
  run(["git", "worktree", "add", "-q", "--detach", release.worktree, "origin/main"], CHECKOUT);
  for (const folder of [".", "video", "desktop"]) run(["bun", "install", "--frozen-lockfile"], join(release.worktree, folder));
  rmSync(release.dist, { recursive: true, force: true });
  mkdirSync(release.dist, { recursive: true });
}

function bump(release: Release) {
  const current = versionIn(release.worktree);
  if (current === release.version) return console.log(`main already names release ${release.version}`);
  if (!isNewerVersion(release.version, current)) throw new Error(`${release.version} is not newer than ${current}, the version on main`);
  const file = join(release.worktree, VERSION_FILE);
  writeFileSync(file, readFileSync(file, "utf8").replace(`MIRADOR_VERSION = "${current}"`, `MIRADOR_VERSION = "${release.version}"`));
  run(["git", "commit", "-q", "-m", `Name this release ${release.version}`, "--", VERSION_FILE], release.worktree);
  run(["git", "push", "-q", "origin", "HEAD:main"], release.worktree);
}

/** Restart specs flake under load, so the gate waits for a mirador-mobile e2e run another session started. */
function gate(release: Release) {
  if (Bun.spawnSync(["pgrep", "-f", "mirador-mobile/e2e/run.ts"]).exitCode === 0) throw new Error("A mirador-mobile e2e run is going on; wait for it to end");
  run(["bunx", "tsc", "--noEmit", "-p", "."], release.worktree);
  run(["bun", "run", "test"], release.worktree);
  run(["scripts/e2e.sh"], release.worktree);
}

function requireLinuxHost() {
  const linuxHost = process.env.LINUX_HOST;
  if (!linuxHost) throw new Error("Name the x64 Linux machine that builds the installers: LINUX_HOST=user@host");
  return linuxHost;
}

/** Both installers build on that machine, as Electrobun's toolchain crashes in Docker on Apple Silicon. */
async function linux(release: Release) {
  const log = await runAndRead(["make", "linux-remote", `LINUX_HOST=${requireLinuxHost()}`, `DIST=${release.dist}`], release.worktree);
  const head = headOf(release);
  const built = log.split("\n").filter((line) => line.startsWith(BUILD_LINE));
  if (built.length === 0 || !built.every((line) => isBuildOf(line, head))) throw new Error(`The Linux builds are not of ${head}: ${built.join("; ")}`);
}

function macos(release: Release) {
  try {
    run(["make", "macos-signed", `DIST=${release.dist}`], release.worktree);
  } catch (error) {
    console.error(`If Apple's notarization outlasted the wait, once it says Accepted: cd ${release.worktree} && make macos-staple DIST=${release.dist}, then go on from the verify step.`);
    throw error;
  }
}

function assessSignature(app: string) {
  const { stderr } = Bun.spawnSync(["spctl", "--assess", "--type", "execute", "-v", app], { stderr: "pipe" });
  const verdict = stderr.toString();
  if (!verdict.includes("accepted") || !verdict.includes("source=Notarized Developer ID")) throw new Error(`macOS does not let ${app} open as notarized: ${verdict.trim()}`);
}

/** The zip is what users get, so the app unzipped from it is checked too. */
function verifyMacos(release: Release) {
  const signed = join(release.dist, "signing", "Mirador.app");
  const bundleVersion = read(["plutil", "-extract", "CFBundleVersion", "raw", join(signed, "Contents", "Info.plist")]);
  if (bundleVersion !== release.version) throw new Error(`The macOS app says ${bundleVersion}, not ${release.version}`);
  assessSignature(signed);
  const unzipped = mkdtempSync(join(tmpdir(), "mirador-release-unzipped-"));
  try {
    const zip = readdirSync(release.dist).find((file) => /^Mirador-macos-.+\.zip$/.test(file));
    if (!zip) throw new Error(`No macOS zip in ${release.dist}`);
    run(["ditto", "-x", "-k", join(release.dist, zip), unzipped], release.worktree);
    assessSignature(join(unzipped, "Mirador.app"));
  } finally {
    rmSync(unzipped, { recursive: true, force: true });
  }
}

function updateFiles(release: Release) {
  run(["make", "update-files", `DIST=${release.dist}`], release.worktree);
  run(["make", "checksums", `DIST=${release.dist}`], release.worktree);
}

function draft(release: Release) {
  if (releasesNamed(release) !== "") throw new Error(`GitHub has a release ${release.tag} already, maybe a draft an earlier run left; delete it with gh release delete ${release.tag} --yes`);
  const assets = releaseAssets(readdirSync(release.dist));
  const missing = missingAssets(assets);
  if (missing.length > 0) throw new Error(`${release.dist} lacks ${missing.join(", ")}`);
  const checksums = assets.map((asset) => `${sha256Of(join(release.dist, asset))}  ${asset}`).join("\n");
  const notes = join(release.dist, "release-notes.md");
  writeFileSync(notes, notesWithChecksums(readFileSync(release.notes, "utf8"), checksums));
  const assetPaths = assets.map((asset) => join(release.dist, asset));
  run(["gh", "release", "create", release.tag, "--draft", "--title", `Mirador ${release.version}`, "--target", headOf(release), "--notes-file", notes, ...assetPaths], release.worktree);
  const mismatches = digestMismatches(Object.fromEntries(assets.map((asset) => [asset, sha256Of(join(release.dist, asset))])), uploadedDigests(release));
  if (mismatches.length > 0) throw new Error(`GitHub holds other files than dist/ for: ${mismatches.join(", ")}`);
  console.log(`\nThe draft of Mirador ${release.version} holds ${assets.length} files, each as built. Publish it with: make publish VERSION=${release.version}`);
}

const RELEASE_STEPS = [
  { name: "worktree", run: makeWorktree },
  { name: "bump", run: bump },
  { name: "gate", run: gate },
  { name: "linux", run: linux },
  { name: "macos", run: macos },
  { name: "verify", run: verifyMacos },
  { name: "update-files", run: updateFiles },
  { name: "draft", run: draft },
];

async function makeRelease(release: Release, from: string | undefined) {
  if (!existsSync(release.notes)) throw new Error(`Write the release notes into ${release.notes} first; the checksums are added to them`);
  const steps = stepsFrom(RELEASE_STEPS, from);
  if (steps.some((step) => step.run === linux)) requireLinuxHost();
  if (steps[0]?.run !== makeWorktree && !existsSync(release.worktree)) throw new Error(`There is no release worktree at ${release.worktree} to go on in; start from the beginning`);
  const goOn = (step: string) => `make release VERSION=${release.version}${process.env.LINUX_HOST ? ` LINUX_HOST=${process.env.LINUX_HOST}` : ""} FROM=${step}`;
  for (const step of steps) {
    console.log(`\n== ${step.name}`);
    try {
      await step.run(release);
    } catch (error) {
      console.error(`\nThe ${step.name} step failed. Once it is fixed, go on with: ${goOn(step.name)}`);
      throw error;
    }
  }
}

function publish(release: Release) {
  run(["gh", "release", "edit", release.tag, "--draft=false", "--latest"], CHECKOUT);
  const target = read(["gh", "release", "view", release.tag, "--json", "targetCommitish", "--jq", ".targetCommitish"]);
  const tagged = read(["gh", "api", `repos/${RELEASES_REPOSITORY}/git/ref/tags/${release.tag}`, "--jq", ".object.sha"]);
  if (tagged !== target) throw new Error(`${release.tag} points at ${tagged}, not at the release's commit ${target}`);
  console.log(`Mirador ${release.version} is out. The cask goes to the tap with: make tap VERSION=${release.version}`);
}

/** The cask names the published assets by their SHA-256, so each must be one GitHub holds. */
function tap(release: Release) {
  const tapFolder = process.env.TAP_DIR || join(homedir(), "prj", "homebrew-tap");
  run(["make", "cask", `DIST=${release.dist}`], release.worktree);
  const cask = join(release.dist, "mirador.rb");
  const mismatches = caskMismatches(readFileSync(cask, "utf8"), uploadedDigests(release));
  if (mismatches.length > 0) throw new Error(`The cask does not name the published SHA-256 of ${mismatches.join(", ")}`);
  if (read(["git", "status", "--porcelain"], tapFolder) !== "") throw new Error(`${tapFolder} has uncommitted changes`);
  copyFileSync(cask, join(tapFolder, "Casks", "mirador.rb"));
  run(["git", "commit", "-q", "-m", `Mirador ${release.version}`, "--", join("Casks", "mirador.rb")], tapFolder);
  run(["git", "push", "-q"], tapFolder);
  console.log("The tap has the new cask. Audit and test it in the Homebrew kit on the Linux machine (run-real.sh).");
}

async function main([command, version, from]: string[]) {
  const release = releaseOf(version ?? "");
  if (command === "release") await makeRelease(release, from);
  else if (command === "publish") publish(release);
  else if (command === "tap") tap(release);
  else throw new Error("Usage: release.ts release|publish|tap <version> [step to go on from]");
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
