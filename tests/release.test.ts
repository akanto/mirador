import { expect, test } from "bun:test";
import { join } from "node:path";
import { caskMismatches, digestMismatches, isBuildOf, missingAssets, notesWithChecksums, releaseAssets, releaseOf, runIdIn, stepsFrom } from "../scripts/release.ts";

test("a release is made in a worktree of its own, into dist/ of the checkout, from the notes there", () => {
  expect(releaseOf("0.5.0", "/checkout", "/tmp")).toEqual({
    version: "0.5.0",
    tag: "v0.5.0",
    worktree: join("/tmp", "mirador-release-0.5.0"),
    dist: join("/checkout", "dist", "0.5.0"),
    notes: join("/checkout", "dist", "release-notes-0.5.0.md"),
    windows: true,
  });
  expect(releaseOf("0.5.0", "/checkout", "/tmp", false).windows).toBe(false);
});

test("a release is named x.y.z", () => {
  for (const version of ["", "v0.5.0", "0.5", "0.5.0-beta"]) expect(() => releaseOf(version)).toThrow("x.y.z");
});

test("the checksums go at the end of the notes", () => {
  const notes = "Mirador 0.5.0 runs on Windows.\n\n## Install\n\ncurl … | sh\n";
  expect(notesWithChecksums(notes, "abc  Mirador-macos-arm64.zip\n")).toBe(
    "Mirador 0.5.0 runs on Windows.\n\n## Install\n\ncurl … | sh\n\n## Checksums (SHA-256)\n\n```\nabc  Mirador-macos-arm64.zip\n```\n",
  );
});

test("the checksums of the files built take the place of any the notes had", () => {
  const notes = "Mirador 0.5.0.\n\n## Checksums (SHA-256)\n\n```\nold  Mirador-macos-arm64.zip\n```\n";
  expect(notesWithChecksums(notes, "new  Mirador-macos-arm64.zip")).toBe("Mirador 0.5.0.\n\n## Checksums (SHA-256)\n\n```\nnew  Mirador-macos-arm64.zip\n```\n");
});

test("the release holds the installers, the update files and the install scripts, nothing else dist/ has", () => {
  const dist = ["signing", "mirador.rb", "release-notes.md", "stable-macos-arm64-update.json", "install.sh", "install.ps1", "Mirador-macos-arm64.zip", "Mirador-linux-x64-Setup.tar.gz"];
  expect(releaseAssets(dist)).toEqual(["Mirador-linux-x64-Setup.tar.gz", "Mirador-macos-arm64.zip", "install.ps1", "install.sh", "stable-macos-arm64-update.json"]);
});

test("a release without Windows leaves out the Windows app and install.ps1, which would fetch it", () => {
  const dist = ["Mirador-macos-arm64.zip", "Mirador-windows-x64-Setup.zip", "install.sh", "install.ps1", "stable-macos-arm64-update.json", "stable-win-x64-update.json", "stable-win-x64-Mirador.tar.zst"];
  expect(releaseAssets(dist, false)).toEqual(["Mirador-macos-arm64.zip", "install.sh", "stable-macos-arm64-update.json"]);
});

test("names the assets GitHub holds other bytes of, or none of", () => {
  const local = { "Mirador-macos-arm64.zip": "aaa", "install.sh": "bbb", "stable-macos-arm64-update.json": "ccc" };
  const uploaded = { "Mirador-macos-arm64.zip": "sha256:aaa", "install.sh": "sha256:bad" };
  expect(digestMismatches(local, uploaded)).toEqual(["install.sh", "stable-macos-arm64-update.json"]);
  expect(digestMismatches(local, { ...uploaded, "install.sh": "sha256:bbb", "stable-macos-arm64-update.json": "sha256:ccc" })).toEqual([]);
});

test("goes on from the step named, or runs them all", () => {
  const steps = [{ name: "bump" }, { name: "gate" }, { name: "draft" }];
  expect(stepsFrom(steps, undefined)).toEqual(steps);
  expect(stepsFrom(steps, "gate")).toEqual([{ name: "gate" }, { name: "draft" }]);
  expect(() => stepsFrom(steps, "linx")).toThrow('There is no step "linx"; the steps are bump, gate, draft');
});

test("the release must hold every installer, both install scripts and each platform's update file", () => {
  const complete = [
    "Mirador-macos-arm64.zip",
    "Mirador-linux-x64-Setup.tar.gz",
    "Mirador-linux-arm64-Setup.tar.gz",
    "Mirador-windows-x64-Setup.zip",
    "install.sh",
    "install.ps1",
    "stable-macos-arm64-update.json",
    "stable-linux-x64-update.json",
    "stable-linux-arm64-update.json",
    "stable-win-x64-update.json",
  ];
  expect(missingAssets(complete)).toEqual([]);
  expect(missingAssets(complete.filter((file) => !file.startsWith("stable-linux-arm64")))).toEqual(["stable-linux-arm64-update.json"]);
  expect(missingAssets(complete.filter((file) => !file.includes("win")))).toEqual(["Mirador-windows-x64-Setup.zip", "stable-win-x64-update.json"]);
  expect(missingAssets(complete.filter((file) => file !== "install.ps1"))).toEqual(["install.ps1"]);
});

test("a release without Windows needs every other installer, install.sh and the other platforms' update files", () => {
  const withoutWindows = [
    "Mirador-macos-arm64.zip",
    "Mirador-linux-x64-Setup.tar.gz",
    "Mirador-linux-arm64-Setup.tar.gz",
    "install.sh",
    "stable-macos-arm64-update.json",
    "stable-linux-x64-update.json",
    "stable-linux-arm64-update.json",
  ];
  expect(missingAssets(withoutWindows, false)).toEqual([]);
  expect(missingAssets(withoutWindows.filter((file) => file !== "install.sh"), false)).toEqual(["install.sh"]);
});

test("follows the Windows build gh started, by the run its URL names", () => {
  expect(runIdIn("https://github.com/sodre90/mirador/actions/runs/38818040351\n")).toBe("38818040351");
  expect(runIdIn("✓ Created workflow_dispatch event for windows-release.yml at main\n")).toBeNull();
});

test("a build line names the commit however many digits its clone shortens it to", () => {
  const commit = "6c6453d0123456789abcdef0123456789abcdef0";
  expect(isBuildOf("== release of v0.4.3-12-g6c6453d", commit)).toBe(true);
  expect(isBuildOf("== release of v0.4.3-12-g6c6453d012", commit)).toBe(true);
  expect(isBuildOf("== release of 6c6453d01", commit)).toBe(true);
  expect(isBuildOf("== release of v0.4.3-12-g1cecc45", commit)).toBe(false);
  expect(isBuildOf("== release of v0.4.3", commit)).toBe(false);
});

test("the cask must name the published SHA-256 of each file it installs", () => {
  const [arm, arm64Linux, x86Linux] = ["a", "b", "c"].map((digit) => digit.repeat(64));
  const cask = `cask "mirador" do\n  sha256 arm:          "${arm}",\n         arm64_linux:  "${arm64Linux}",\n         x86_64_linux: "${x86Linux}"\n`;
  const published = { "Mirador-macos-arm64.zip": `sha256:${arm}`, "Mirador-linux-arm64-Setup.tar.gz": `sha256:${arm64Linux}`, "Mirador-linux-x64-Setup.tar.gz": `sha256:${x86Linux}` };
  expect(caskMismatches(cask, published)).toEqual([]);
  expect(caskMismatches(cask, { ...published, "Mirador-linux-x64-Setup.tar.gz": `sha256:${"d".repeat(64)}` })).toEqual(["Mirador-linux-x64-Setup.tar.gz"]);
  expect(caskMismatches(cask, { "Mirador-macos-arm64.zip": `sha256:${arm}` })).toEqual(["Mirador-linux-x64-Setup.tar.gz", "Mirador-linux-arm64-Setup.tar.gz"]);
});
