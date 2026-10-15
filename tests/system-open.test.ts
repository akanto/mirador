import { expect, test } from "bun:test";
import { systemOpenCommand } from "../host/system-open.ts";

test("each platform opens a file with its own default-program command", () => {
  expect(systemOpenCommand("/a/b.png", "darwin")).toEqual(["open", "/a/b.png"]);
  expect(systemOpenCommand("/a/b.png", "linux")).toEqual(["xdg-open", "/a/b.png"]);
  expect(systemOpenCommand("C:\\a\\b.png", "win32")).toEqual(["cmd", "/c", "start", "", "C:\\a\\b.png"]);
});
