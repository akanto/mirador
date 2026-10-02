import { describe, expect, test } from "bun:test";
import { pageRequest, showMenuScript, windowMenu } from "../desktop/src/core/window-menu.ts";

const state = { status: "owned", hostRunsInBackground: true, openAtLogin: false } as const;

describe("menu in the window", () => {
  test("is the tray's menu without Open", () => {
    const labels = windowMenu(state).map((item) => (item.type === "normal" ? item.label : "—"));
    expect(labels).toEqual(["Host: running, started by this app", "—", "Restart host", "Run host in the background", "Open at login", "—", "Quit"]);
    expect(windowMenu(state).find((item) => item.type === "normal" && item.action === "toggle-background")).toMatchObject({ checked: true });
  });

  test("reaches the page as an event carrying the nonce and the items", () => {
    const script = showMenuScript({ nonce: "n-1", items: [{ type: "normal", label: 'Say "hi" </script>' }] });
    expect(script).toBe(
      'window.dispatchEvent(new CustomEvent("mirador:desktop-menu", { detail: {"nonce":"n-1","items":[{"type":"normal","label":"Say \\"hi\\" </script>"}]} }))',
    );
  });

  test("acts only on an action that carries the nonce, while anyone may ask for the menu", () => {
    expect(pageRequest({ type: "desktop-menu-request" }, "n-1")).toEqual({ type: "menu" });
    expect(pageRequest({ type: "desktop-action", nonce: "n-1", action: "quit" }, "n-1")).toEqual({ type: "action", action: "quit" });
    expect(pageRequest({ type: "desktop-action", nonce: "guess", action: "quit" }, "n-1")).toBeNull();
    expect(pageRequest({ type: "desktop-action", action: "quit" }, "n-1")).toBeNull();
    expect(pageRequest({ type: "desktop-action", nonce: "n-1", action: "rm -rf" }, "n-1")).toBeNull();
    expect(pageRequest("quit", "n-1")).toBeNull();
    expect(pageRequest(null, "n-1")).toBeNull();
  });
});
