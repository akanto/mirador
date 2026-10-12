import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardDownload, replacedFolder, signedBySameTeam, skippedBuilds, teamIdentifierIn, updateBlockedBy } from "../desktop/src/core/update-checks.ts";

let channel: string;
beforeEach(() => {
  channel = mkdtempSync(join(tmpdir(), "mirador-update-checks-"));
});
afterEach(() => rmSync(channel, { recursive: true, force: true }));

test("the team comes from codesign's details, and an app signed ad hoc or not at all has none", () => {
  expect(teamIdentifierIn("Identifier=com.sodre90.mirador\nTeamIdentifier=P8NM5HKXRJ\nSealed Resources version=2\n")).toBe("P8NM5HKXRJ");
  expect(teamIdentifierIn("Signature=adhoc\nTeamIdentifier=not set\n")).toBeNull();
  expect(teamIdentifierIn("code object is not signed at all\n")).toBeNull();
});

test("an app whose own team is unknown lets no update in", async () => {
  expect(await signedBySameTeam(join(channel, "missing.tar"), join(channel, "Missing.app"))).toBe(false);
});

test("an update replaces the app bundle on macOS, and the folder holding the launcher on Linux", () => {
  expect(replacedFolder("/Applications/Mirador.app", "darwin")).toBe("/Applications/Mirador.app");
  expect(replacedFolder("/home/me/.local/share/com.sodre90.mirador/stable/app/bin/launcher", "linux")).toBe("/home/me/.local/share/com.sodre90.mirador/stable/app");
});

test("an app opened from a read-only copy, or kept in a folder it may not write, cannot replace itself, and says what to do", () => {
  const writable = () => true;
  const readOnly = () => false;
  expect(updateBlockedBy("/private/var/folders/x/T/AppTranslocation/ABC/d/Mirador.app", "darwin", writable)).toBe("move Mirador to Applications to update it");
  expect(updateBlockedBy("/Applications/Mirador.app", "darwin", readOnly)).toBe("Mirador cannot replace itself in /Applications");
  expect(updateBlockedBy("/Applications/Mirador.app", "darwin", writable)).toBeNull();
  expect(updateBlockedBy("/home/me/.local/share/com.sodre90.mirador/stable/app", "linux", writable)).toBeNull();
});

test("discarding a download deletes it and its prepared note, and keeps the running build's archive that patches apply to", () => {
  const extraction = join(channel, "self-extraction");
  mkdirSync(extraction);
  ["running.tar", "downloaded.tar", ".electrobun-prepared-update.json"].forEach((name) => writeFileSync(join(extraction, name), name));

  discardDownload(channel, "downloaded");

  expect(existsSync(join(extraction, "running.tar"))).toBe(true);
  expect(existsSync(join(extraction, "downloaded.tar"))).toBe(false);
  expect(existsSync(join(extraction, ".electrobun-prepared-update.json"))).toBe(false);
});

test("skipped builds are remembered across starts, and an unreadable list skips nothing", () => {
  skippedBuilds(channel).add("bad1");
  skippedBuilds(channel).add("bad2");
  skippedBuilds(channel).add("bad1");

  expect(["bad1", "bad2", "good"].map(skippedBuilds(channel).has)).toEqual([true, true, false]);
  writeFileSync(join(channel, "mirador-skipped-updates.json"), "{not json");
  expect(skippedBuilds(channel).has("bad1")).toBe(false);
});
