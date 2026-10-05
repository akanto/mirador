import { describe, expect, test } from "bun:test";
import { navigationRules, webUrl } from "../desktop/src/core/navigation.ts";
import { trayMenu, type TrayItem, type TrayState } from "../desktop/src/core/tray-menu.ts";

const state: TrayState = { status: "owned", hostRunsInBackground: false, openAtLogin: true };
const item = (items: TrayItem[], label: string) => items.find((candidate) => candidate.type === "normal" && candidate.label.startsWith(label));

describe("tray menu", () => {
  test("lists the actions in order with the checkboxes reflecting the settings", () => {
    const items = trayMenu(state);
    expect(items.map((entry) => (entry.type === "normal" ? entry.label : "-"))).toEqual([
      "Host: running, started by this app",
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

  test("shows the status line as information, not an action", () => {
    expect(trayMenu(state)[0]).toMatchObject({ enabled: false });
    expect((trayMenu(state)[0] as { action?: string }).action).toBeUndefined();
  });

  test("disables and explains restarting a host the app did not start", () => {
    expect(item(trayMenu({ ...state, status: "external" }), "Restart host")).toMatchObject({ label: "Restart host (not started by this app)", enabled: false });
  });

  test("enables restarting for owned, background and stopped hosts", () => {
    for (const status of ["owned", "background", "stopped"] as const) {
      expect(item(trayMenu({ ...state, status }), "Restart host")).toMatchObject({ label: "Restart host", enabled: true });
    }
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
