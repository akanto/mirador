import { expect, test } from "bun:test";
import { firstTrayTitle, trayTitle } from "../desktop/src/core/tray-menu.ts";

test("the tray shows the number of conversations waiting for you, and nothing when none waits", () => {
  expect(trayTitle(3)).toBe("3");
  expect(trayTitle(0)).toBe("");
});

test("Linux panels name the tray icon after the app instead of the process running it, while macOS keeps the title for the count", () => {
  expect(firstTrayTitle("linux", "Mirador")).toBe("Mirador");
  expect(firstTrayTitle("darwin", "Mirador")).toBe("");
});
