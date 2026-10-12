import { describe, expect, test } from "bun:test";
import { MIRADOR_VERSION } from "../shared/version.ts";
import { closeWhatHasFocusScript, giveNonceScript, pageRequest, showMenuScript, showUpdateScript, windowMenu } from "../desktop/src/core/window-menu.ts";

const state = { status: "owned", hostRunsInBackground: true, openAtLogin: false, newerVersion: null, update: null } as const;

describe("menu in the window", () => {
  test("is the tray's menu without Open", () => {
    const labels = windowMenu(state).map((item) => (item.type === "normal" ? item.label : "—"));
    expect(labels).toEqual([
      "Host: running, started by this app",
      `Mirador ${MIRADOR_VERSION}`,
      "—",
      "Restart host",
      "Run host in the background",
      "Open at login",
      "—",
      "Quit",
    ]);
    expect(windowMenu(state).find((item) => item.type === "normal" && item.action === "toggle-background")).toMatchObject({ checked: true });
  });

  test("has the tray's newer release, which the Linux sidebar's menu then offers too", () => {
    const newerVersion = { kind: "release", version: "9.9.9", url: "https://github.com/sodre90/mirador/releases/tag/v9.9.9" } as const;
    expect(windowMenu({ ...state, newerVersion })[2]).toMatchObject({ label: "Mirador 9.9.9 is out: download", action: "download-newer-version" });
    expect(pageRequest({ type: "desktop-action", nonce: "n-1", action: "download-newer-version" }, "n-1")).toEqual({ type: "action", action: "download-newer-version" });
  });

  test("reaches the page as an event carrying the nonce and the items", () => {
    const script = showMenuScript({ nonce: "n-1", items: [{ type: "normal", label: 'Say "hi" </script>' }] });
    expect(script).toBe(
      'window.dispatchEvent(new CustomEvent("mirador:desktop-menu", { detail: {"nonce":"n-1","items":[{"type":"normal","label":"Say \\"hi\\" </script>"}]} }))',
    );
  });

  test("tells the page an update is ready to install or clears it", () => {
    expect(showUpdateScript({ version: "0.4.1" })).toBe('window.dispatchEvent(new CustomEvent("mirador:desktop-update", { detail: {"version":"0.4.1"} }))');
    expect(showUpdateScript(null)).toBe('window.dispatchEvent(new CustomEvent("mirador:desktop-update", { detail: null }))');
  });

  test("acts only on an action that carries the nonce, while anyone may ask for the menu", () => {
    expect(pageRequest({ type: "desktop-menu-request" }, "n-1")).toEqual({ type: "menu" });
    expect(pageRequest({ type: "desktop-action", nonce: "n-1", action: "quit" }, "n-1")).toEqual({ type: "action", action: "quit" });
    expect(pageRequest({ type: "desktop-action", nonce: "n-1", action: "install-update" }, "n-1")).toEqual({ type: "action", action: "install-update" });
    expect(pageRequest({ type: "desktop-action", nonce: "guess", action: "quit" }, "n-1")).toBeNull();
    expect(pageRequest({ type: "desktop-action", action: "quit" }, "n-1")).toBeNull();
    expect(pageRequest({ type: "desktop-action", nonce: "n-1", action: "rm -rf" }, "n-1")).toBeNull();
    expect(pageRequest("quit", "n-1")).toBeNull();
    expect(pageRequest(null, "n-1")).toBeNull();
  });

  test("anyone may ask for the nonce, which the app gives only to its window's own page", () => {
    expect(pageRequest({ type: "desktop-nonce-request" }, "n-1")).toEqual({ type: "nonce" });
    expect(giveNonceScript("n-1")).toBe('window.dispatchEvent(new CustomEvent("mirador:desktop-nonce", { detail: "n-1" }))');
  });

  test("asks the page to close what has focus, and closes the window only when the page asks with the nonce", () => {
    expect(closeWhatHasFocusScript).toBe('window.dispatchEvent(new CustomEvent("mirador:desktop-close"))');
    expect(pageRequest({ type: "desktop-close-window", nonce: "n-1" }, "n-1")).toEqual({ type: "close-window" });
    expect(pageRequest({ type: "desktop-close-window", nonce: "guess" }, "n-1")).toBeNull();
    expect(pageRequest({ type: "desktop-close-window" }, "n-1")).toBeNull();
  });

  test("opens a link only when the request carries the nonce and the link is a web address", () => {
    const link = { type: "desktop-open-link", nonce: "n-1", url: "https://example.com/a" };
    expect(pageRequest(link, "n-1")).toEqual({ type: "open-link", url: "https://example.com/a" });
    expect(pageRequest({ ...link, nonce: "guess" }, "n-1")).toBeNull();
    expect(pageRequest({ type: "desktop-open-link", url: link.url }, "n-1")).toBeNull();
    for (const url of ["file:///etc/passwd", "slack://open", "javascript:alert(1)", "not a url", 7, null]) {
      expect(pageRequest({ ...link, url }, "n-1")).toBeNull();
    }
  });

  test("gives the window the theme only when the page asks with the nonce, and only a theme Mirador has", () => {
    for (const appearance of ["light", "dark", "system"] as const) {
      expect(pageRequest({ type: "desktop-appearance", nonce: "n-1", appearance }, "n-1")).toEqual({ type: "appearance", appearance });
    }
    expect(pageRequest({ type: "desktop-appearance", nonce: "guess", appearance: "dark" }, "n-1")).toBeNull();
    expect(pageRequest({ type: "desktop-appearance", appearance: "dark" }, "n-1")).toBeNull();
    for (const appearance of ["sepia", "", null, 1]) {
      expect(pageRequest({ type: "desktop-appearance", nonce: "n-1", appearance }, "n-1")).toBeNull();
    }
  });
});
