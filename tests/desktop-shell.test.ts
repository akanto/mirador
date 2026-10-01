import { describe, expect, test } from "bun:test";
import { blockedNavigationUrl, navigationRules, openedWindowUrl } from "../desktop/src/core/navigation.ts";
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

  test("opens a new window's web link in the browser", () => {
    expect(openedWindowUrl({ url: "https://example.com/a?b=1", isCmdClick: false })).toBe("https://example.com/a?b=1");
    expect(openedWindowUrl({ url: "http://example.com/" })).toBe("http://example.com/");
  });

  test("opens only web links, never other schemes", () => {
    for (const url of ["file:///etc/passwd", "slack://open", "javascript:alert(1)", "not a url"]) {
      expect(openedWindowUrl({ url })).toBeNull();
    }
    expect(openedWindowUrl(undefined)).toBeNull();
    expect(openedWindowUrl("https://example.com/")).toBeNull();
  });

  test("hands a blocked navigation's url to the browser and ignores an allowed one", () => {
    expect(blockedNavigationUrl('{"url":"https://example.com/x","allowed":false}')).toBe("https://example.com/x");
    expect(blockedNavigationUrl('{"url":"http://127.0.0.1:4600/","allowed":true}')).toBeNull();
    expect(blockedNavigationUrl('{"url":"slack://open","allowed":false}')).toBeNull();
    expect(blockedNavigationUrl("not json")).toBeNull();
    expect(blockedNavigationUrl(undefined)).toBeNull();
  });
});
