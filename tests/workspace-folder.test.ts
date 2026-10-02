import { expect, test } from "bun:test";
import { parentFolder } from "../web/workspace-folder.ts";

const home = "/Users/ada";

test("names the folder holding the workspace, with home as ~", () => {
  expect(parentFolder("/Users/ada/prj/mirador", home)).toBe("~/prj");
  expect(parentFolder("/Users/ada/prj/mirador/", home)).toBe("~/prj");
  expect(parentFolder("/Users/ada/dotfiles", home)).toBe("~");
});

test("leaves folders outside home as they are, even ones whose name starts like it", () => {
  expect(parentFolder("/Users/ada2/src/x", home)).toBe("/Users/ada2/src");
  expect(parentFolder("/Users/ada", home)).toBe("/Users");
  expect(parentFolder("/opt/tools", home)).toBe("/opt");
  expect(parentFolder("/srv", home)).toBe("/");
});

test("shows the full folder until the host has said where home is", () => {
  expect(parentFolder("/Users/ada/prj/mirador", "")).toBe("/Users/ada/prj");
});
