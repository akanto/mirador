import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installedAppPath } from "../desktop/src/core/app-bundle.ts";
import { hostArgv, isHostCommandLine, loginShell } from "../desktop/src/core/host-command.ts";
import { authUrl, dataPaths, hostEnvironmentOverrides, resolveRuntime } from "../desktop/src/core/runtime.ts";
import { relayPorts } from "../shared/relay-ports.ts";

const home = "/Users/someone";

/** The desktop app does not run on Windows yet: its paths and the way it starts its host there are still to come. */
const testOnceTheDesktopRunsOnWindows = test.todoIf(process.platform === "win32");

describe("runtime", () => {
  testOnceTheDesktopRunsOnWindows("defaults to the real app's port, its canvas port and data directory", () => {
    expect(resolveRuntime({}, home)).toEqual({
      port: 4600,
      canvasPort: 4601,
      dataDir: "/Users/someone/.mirador",
      origin: "http://127.0.0.1:4600",
      canvasOrigin: "http://127.0.0.1:4601",
      relayOrigins: expect.any(Array),
    });
  });

  test("lets the window show the host's other machines at every port the host may relay them on", () => {
    const { relayOrigins } = resolveRuntime({ MIRADOR_PORT: "4790" }, home);
    expect(relayOrigins).toEqual(relayPorts(4790).map((port) => `http://127.0.0.1:${port}`));
    expect(relayOrigins).toContain("http://127.0.0.1:4810");
  });

  test("follows the host's environment overrides, the canvas port tracking the port", () => {
    const runtime = resolveRuntime({ MIRADOR_PORT: "4790", MIRADOR_DATA_DIR: "/scratch" }, home);
    expect(runtime).toMatchObject({ port: 4790, canvasPort: 4791, dataDir: "/scratch", origin: "http://127.0.0.1:4790", canvasOrigin: "http://127.0.0.1:4791" });
    expect(resolveRuntime({ MIRADOR_PORT: "4790", MIRADOR_CANVAS_PORT: "5000" }, home).canvasPort).toBe(5000);
  });

  test("ignores a port that is not a port", () => {
    expect(resolveRuntime({ MIRADOR_PORT: "abc" }, home).port).toBe(4600);
    expect(resolveRuntime({ MIRADOR_PORT: "70000" }, home).port).toBe(4600);
  });

  test("passes the host nothing when everything is default", () => {
    expect(hostEnvironmentOverrides(resolveRuntime({}, home), home)).toEqual({});
  });

  test("passes the host only what differs from its defaults", () => {
    const runtime = resolveRuntime({ MIRADOR_PORT: "4790", MIRADOR_CANVAS_PORT: "4900", MIRADOR_DATA_DIR: "/scratch" }, home);
    expect(hostEnvironmentOverrides(runtime, home)).toEqual({ MIRADOR_PORT: "4790", MIRADOR_CANVAS_PORT: "4900", MIRADOR_DATA_DIR: "/scratch" });
    expect(hostEnvironmentOverrides(resolveRuntime({ MIRADOR_PORT: "4790" }, home), home)).toEqual({ MIRADOR_PORT: "4790" });
  });

  testOnceTheDesktopRunsOnWindows("keeps the app's own files in the data directory", () => {
    expect(dataPaths("/data")).toEqual({
      settings: "/data/desktop.json",
      ownedHostPid: "/data/desktop-host.pid",
      hostLog: "/data/logs/host.log",
      browserToken: "/data/browser-token",
      pendingUpdate: "/data/desktop-update-pending",
    });
  });

  test("builds the sign-in url from the origin and token", () => {
    expect(authUrl(resolveRuntime({}, home), "abc")).toBe("http://127.0.0.1:4600/auth?token=abc");
  });
});

describe("host command", () => {
  test("runs bun through the login shell so the user's profile applies, back in the host's directory", () => {
    expect(hostArgv("/bin/zsh", "/bun/bin/bun", {}, "/Apps/mirador")).toEqual(["/bin/zsh", "-ilc", 'cd -- "$0" && exec "$@"', "/Apps/mirador", "/bun/bin/bun", "host/main.ts"]);
  });

  test("hands overrides over as command-line assignments, never the environment", () => {
    expect(hostArgv("/bin/zsh", "/bun/bin/bun", { MIRADOR_PORT: "4790" }, "/Apps/mirador")).toEqual([
      "/bin/zsh", "-ilc", 'cd -- "$0" && exec "$@"', "/Apps/mirador", "/usr/bin/env", "MIRADOR_PORT=4790", "/bun/bin/bun", "host/main.ts",
    ]);
  });

  testOnceTheDesktopRunsOnWindows("finds the host's entry even when the user's profile changes directory", () => {
    const home = mkdtempSync(join(tmpdir(), "mirador-home-"));
    const hostDirectory = mkdtempSync(join(tmpdir(), "mirador-app-"));
    writeFileSync(join(home, ".bash_profile"), "cd /\n");
    mkdirSync(join(hostDirectory, "host"));
    writeFileSync(join(hostDirectory, "host", "main.ts"), "");
    try {
      const run = Bun.spawnSync(hostArgv("/bin/bash", "/bin/ls", {}, hostDirectory), { cwd: hostDirectory, env: { HOME: home, PATH: "/usr/bin:/bin" }, stdin: "ignore" });
      expect(run.stdout.toString().trim()).toBe("host/main.ts");
      expect(run.exitCode).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(hostDirectory, { recursive: true, force: true });
    }
  });

  test("speaks fish's own syntax when the login shell is fish", () => {
    expect(hostArgv("/opt/homebrew/bin/fish", "/bun/bin/bun", {}, "/Apps/mirador")).toEqual([
      "/opt/homebrew/bin/fish", "-ilc", "cd -- $argv[1] && exec $argv[2..-1]", "/Apps/mirador", "/bun/bin/bun", "host/main.ts",
    ]);
  });

  const fish = Bun.which("fish");
  test.skipIf(!fish)("finds the host's entry under fish too, when its config changes directory", () => {
    const home = mkdtempSync(join(tmpdir(), "mirador-home-"));
    const hostDirectory = mkdtempSync(join(tmpdir(), "mirador-app-"));
    mkdirSync(join(home, ".config", "fish"), { recursive: true });
    writeFileSync(join(home, ".config", "fish", "config.fish"), "cd /\n");
    mkdirSync(join(hostDirectory, "host"));
    writeFileSync(join(hostDirectory, "host", "main.ts"), "");
    try {
      const run = Bun.spawnSync(hostArgv(fish!, "/bin/ls", {}, hostDirectory), { cwd: hostDirectory, env: { HOME: home, PATH: "/usr/bin:/bin" }, stdin: "ignore" });
      expect(run.stdout.toString().trim()).toBe("host/main.ts");
      expect(run.exitCode).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(hostDirectory, { recursive: true, force: true });
    }
  });

  test("uses the environment's shell, then the account's, then sh", () => {
    expect(loginShell({ SHELL: "/bin/bash" }, "/bin/fish")).toBe("/bin/bash");
    expect(loginShell({}, "/bin/fish")).toBe("/bin/fish");
    expect(loginShell({}, undefined)).toBe("/bin/sh");
  });

  test("recognises a running host by its command line, before and after the shell hands over", () => {
    expect(isHostCommandLine("/Users/me/.bun/bin/bun host/main.ts")).toBe(true);
    expect(isHostCommandLine("bun host/main.ts")).toBe(true);
    expect(isHostCommandLine('/bin/zsh -ilc exec "$0" "$@" /Users/me/.bun/bin/bun host/main.ts')).toBe(true);
    expect(isHostCommandLine('/bin/zsh -ilc exec "$0" "$@" /usr/bin/env MIRADOR_PORT=4790 /Users/me/.bun/bin/bun host/main.ts')).toBe(true);
    expect(isHostCommandLine('/bin/zsh -ilc cd -- "$0" && exec "$@" /Apps/mirador /Users/me/.bun/bin/bun host/main.ts')).toBe(true);
  });

  test("does not mistake other processes for a host", () => {
    expect(isHostCommandLine("vim host/main.ts")).toBe(false);
    expect(isHostCommandLine("/Users/me/.bun/bin/bun host/main.ts --watch")).toBe(false);
    expect(isHostCommandLine("/usr/bin/python3 server.py")).toBe(false);
    expect(isHostCommandLine("")).toBe(false);
  });
});

describe("installed app", () => {
  test("is the .app around the running executable on macOS", () => {
    expect(installedAppPath("/Applications/Mirador.app/Contents/MacOS/bun", "darwin")).toBe("/Applications/Mirador.app");
    expect(installedAppPath("/a/b.app/Contents/Resources/c.app/Contents/MacOS/bun", "darwin")).toBe("/a/b.app/Contents/Resources/c.app");
  });

  test("is the launcher beside the runtime on Linux", () => {
    expect(installedAppPath("/home/me/.local/share/com.sodre90.mirador/stable/app/bin/bun", "linux")).toBe(
      "/home/me/.local/share/com.sodre90.mirador/stable/app/bin/launcher",
    );
  });

  test("is absent when bun runs outside an installed app", () => {
    expect(installedAppPath("/Users/me/.bun/bin/bun", "darwin")).toBeNull();
    expect(installedAppPath("/home/me/.bun/bin/bun", "linux")).toBeNull();
  });
});
