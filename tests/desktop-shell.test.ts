import { describe, expect, test } from "bun:test";
import { navigationRules, webUrl } from "../desktop/src/core/navigation.ts";
import { MIRADOR_VERSION } from "../shared/version.ts";
import { trayMenu, type TrayItem, type TrayState } from "../desktop/src/core/tray-menu.ts";

const state: TrayState = { status: "owned", hostRunsInBackground: false, openAtLogin: true, newerVersion: null };
const item = (items: TrayItem[], label: string) => items.find((candidate) => candidate.type === "normal" && candidate.label.startsWith(label));

describe("tray menu", () => {
  test("lists the actions in order with the checkboxes reflecting the settings", () => {
    const items = trayMenu(state);
    expect(items.map((entry) => (entry.type === "normal" ? entry.label : "-"))).toEqual([
      "Host: running, started by this app",
      `Mirador ${MIRADOR_VERSION}`,
      "Open",
      "-",
      "Restart host",
      "Run host in the background",
      "Open at login",
      "-",
      "Quit",
    ]);
    expect(item(items, "Run host in the background")).toMatchObject({ checked: false, action: "toggle-background" });
    expect(item(items, "Open at login")).toMatchObject({ checked: true, action: "toggle-open-at-login" });
  });

  test("shows the status line and the version as information, not actions", () => {
    expect(trayMenu(state)[0]).toMatchObject({ enabled: false });
    expect((trayMenu(state)[0] as { action?: string }).action).toBeUndefined();
    expect(trayMenu(state)[1]).toMatchObject({ label: `Mirador ${MIRADOR_VERSION}`, enabled: false });
  });

  test("disables and explains restarting a host the app did not start", () => {
    expect(item(trayMenu({ ...state, status: "external" }), "Restart host")).toMatchObject({ label: "Restart host (not started by this app)", enabled: false });
  });

  test("enables restarting for owned, background and stopped hosts", () => {
    for (const status of ["owned", "background", "stopped"] as const) {
      expect(item(trayMenu({ ...state, status }), "Restart host")).toMatchObject({ label: "Restart host", enabled: true });
    }
  });

  test("offers a newer release's download page under the version, and tells new commits on a checkout's upstream", () => {
    const withRelease = trayMenu({ ...state, newerVersion: { kind: "release", version: "9.9.9", url: "https://github.com/sodre90/mirador/releases/tag/v9.9.9" } });
    expect(withRelease[2]).toEqual({ type: "normal", label: "Mirador 9.9.9 is out: download", action: "download-newer-version" });
    const withCommits = trayMenu({ ...state, newerVersion: { kind: "checkout", commits: 1, upstream: "origin/main", upstreamCommit: "abc" } });
    expect(withCommits[2]).toEqual({ type: "normal", label: "1 new commit on origin/main", enabled: false });
    expect(trayMenu(state)[2]).toMatchObject({ label: "Open" });
  });

  test("shows the background checkbox ticked when the setting is on", () => {
    expect(item(trayMenu({ ...state, hostRunsInBackground: true }), "Run host in the background")).toMatchObject({ checked: true });
  });
});

describe("navigation", () => {
  test("blocks everything but the app's own origins and inline documents", () => {
    expect(navigationRules(["http://127.0.0.1:4600", "http://127.0.0.1:4601"])).toEqual(["^*", "http://127.0.0.1:4600/*", "http://127.0.0.1:4601/*", "about:*"]);
  });

  test("tells web links from everything else the page might ask the browser to open", () => {
    expect(webUrl("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(webUrl("http://example.com/")).toBe("http://example.com/");
    for (const url of ["file:///etc/passwd", "slack://open", "javascript:alert(1)", "not a url", undefined, null]) {
      expect(webUrl(url)).toBeNull();
    }
  });
});
