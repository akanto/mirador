import { describe, expect, test } from "bun:test";
import { appBundlePath } from "../desktop/src/core/app-bundle.ts";
import { hostArgv, isHostCommandLine, loginShell } from "../desktop/src/core/host-command.ts";
import { authUrl, dataPaths, hostEnvironmentOverrides, resolveRuntime } from "../desktop/src/core/runtime.ts";

const home = "/Users/someone";

describe("runtime", () => {
  test("defaults to the real app's port, its canvas port and data directory", () => {
    expect(resolveRuntime({}, home)).toEqual({
      port: 4600,
      canvasPort: 4601,
      dataDir: "/Users/someone/.mirador",
      origin: "http://127.0.0.1:4600",
      canvasOrigin: "http://127.0.0.1:4601",
    });
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

  test("keeps the app's own files in the data directory", () => {
    expect(dataPaths("/data")).toEqual({
      settings: "/data/desktop.json",
      ownedHostPid: "/data/desktop-host.pid",
      hostLog: "/data/logs/host.log",
      browserToken: "/data/browser-token",
    });
  });

  test("builds the sign-in url from the origin and token", () => {
    expect(authUrl(resolveRuntime({}, home), "abc")).toBe("http://127.0.0.1:4600/auth?token=abc");
  });
});

describe("host command", () => {
  test("runs bun through the login shell so the user's profile applies", () => {
    expect(hostArgv("/bin/zsh", "/bun/bin/bun", {})).toEqual(["/bin/zsh", "-ilc", 'exec "$0" "$@"', "/bun/bin/bun", "host/main.ts"]);
  });

  test("hands overrides over as command-line assignments, never the environment", () => {
    expect(hostArgv("/bin/zsh", "/bun/bin/bun", { MIRADOR_PORT: "4790" })).toEqual([
      "/bin/zsh", "-ilc", 'exec "$0" "$@"', "/usr/bin/env", "MIRADOR_PORT=4790", "/bun/bin/bun", "host/main.ts",
    ]);
  });

  test("uses the environment's shell, then the account's, then zsh", () => {
    expect(loginShell({ SHELL: "/bin/bash" }, "/bin/fish")).toBe("/bin/bash");
    expect(loginShell({}, "/bin/fish")).toBe("/bin/fish");
    expect(loginShell({}, undefined)).toBe("/bin/zsh");
  });

  test("recognises a running host by its command line, before and after the shell hands over", () => {
    expect(isHostCommandLine("/Users/me/.bun/bin/bun host/main.ts")).toBe(true);
    expect(isHostCommandLine("bun host/main.ts")).toBe(true);
    expect(isHostCommandLine('/bin/zsh -ilc exec "$0" "$@" /Users/me/.bun/bin/bun host/main.ts')).toBe(true);
    expect(isHostCommandLine('/bin/zsh -ilc exec "$0" "$@" /usr/bin/env MIRADOR_PORT=4790 /Users/me/.bun/bin/bun host/main.ts')).toBe(true);
  });

  test("does not mistake other processes for a host", () => {
    expect(isHostCommandLine("vim host/main.ts")).toBe(false);
    expect(isHostCommandLine("/Users/me/.bun/bin/bun host/main.ts --watch")).toBe(false);
    expect(isHostCommandLine("/usr/bin/python3 server.py")).toBe(false);
    expect(isHostCommandLine("")).toBe(false);
  });
});

describe("app bundle", () => {
  test("is the .app around the running executable", () => {
    expect(appBundlePath("/Applications/Mirador.app/Contents/MacOS/bun")).toBe("/Applications/Mirador.app");
    expect(appBundlePath("/a/b.app/Contents/Resources/c.app/Contents/MacOS/bun")).toBe("/a/b.app/Contents/Resources/c.app");
  });

  test("is absent when bun runs outside a bundle", () => {
    expect(appBundlePath("/Users/me/.bun/bin/bun")).toBeNull();
  });
});
