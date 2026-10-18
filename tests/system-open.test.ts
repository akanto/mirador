import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isProgram, systemOpenCommand } from "../host/system-open.ts";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "mirador-system-open-"));
});
afterEach(() => rm(directory, { recursive: true, force: true }));

test("each platform opens a file with its own default-program command", () => {
  expect(systemOpenCommand("/a/b.png", "darwin")).toEqual({ command: ["open", "/a/b.png"], environment: {} });
  expect(systemOpenCommand("/a/b.png", "linux")).toEqual({ command: ["xdg-open", "/a/b.png"], environment: {} });
});

test("on Windows the file reaches the default program through the environment, never through a command line cmd would read", () => {
  const file = "C:\\a\\opener.cmd&probe&.txt";
  const { command, environment } = systemOpenCommand(file, "win32");
  expect(command.join(" ")).not.toContain(file);
  expect(command.some((part) => part.toLowerCase().includes("cmd"))).toBe(false);
  expect(environment).toEqual({ MIRADOR_OPEN_FILE: file });
});

test("a file Windows would run is a program, by PATHEXT or by the other extensions its default action runs", () => {
  expect(isProgram("C:\\a\\setup.EXE", "win32", { PATHEXT: ".COM;.EXE;.BAT" })).toBe(true);
  expect(isProgram("C:\\a\\run.bat", "win32", { PATHEXT: ".COM;.EXE;.BAT" })).toBe(true);
  expect(isProgram("C:\\a\\tool.js", "win32", {})).toBe(true);
  expect(isProgram("C:\\a\\setup.EXE", "win32", { PATHEXT: "" })).toBe(true);
  expect(isProgram("C:\\a\\shortcut.lnk", "win32", {})).toBe(true);
  expect(isProgram("C:\\a\\notes.md", "win32", {})).toBe(false);
  expect(isProgram("C:\\a\\diagram.png", "win32", {})).toBe(false);
});

test("on macOS and Linux a file is a program when it is executable or its type runs when opened", async () => {
  const script = join(directory, "build");
  const notes = join(directory, "notes.md");
  await writeFile(script, "#!/bin/sh\n");
  await chmod(script, 0o755);
  await writeFile(notes, "notes\n");
  // NTFS carries no executable bit, so a chmod there leaves no trace: the file is a program exactly when the disk says so.
  const isExecutable = ((await stat(script)).mode & 0o111) !== 0;
  for (const platform of ["darwin", "linux"] as const) {
    expect(isProgram(script, platform)).toBe(isExecutable);
    expect(isProgram(notes, platform)).toBe(false);
  }
  expect(isProgram(join(directory, "Tool.app"), "darwin")).toBe(true);
  expect(isProgram(join(directory, "run.command"), "darwin")).toBe(true);
  expect(isProgram(join(directory, "launcher.desktop"), "linux")).toBe(true);
});
