import { expect, test } from "bun:test";
import { trayTitle } from "../desktop/src/core/tray-menu.ts";

test("the tray shows the number of conversations waiting for you, and nothing when none waits", () => {
  expect(trayTitle(3)).toBe("3");
  expect(trayTitle(0)).toBe("");
});
