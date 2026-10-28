import { describe, expect, test } from "bun:test";
import { machineInitials, workspaceInitials, workspaceMarkColor } from "../shared/marks.ts";

describe("marks", () => {
  test("a workspace's mark takes its colour from the name, the same in every window and on the phone", () => {
    expect(["mirador", "jira-intel", "dotfiles", "notes"].map(workspaceMarkColor)).toEqual(["#12a594", "#8e4ec6", "#12a594", "#d9822b"]);
  });

  test("a workspace shows one letter from each of two words, or the first two of one", () => {
    expect(workspaceInitials("home-server")).toBe("HS");
    expect(workspaceInitials("mirador")).toBe("MI");
    expect(workspaceInitials("élan vital")).toBe("ÉV");
  });

  test("a machine shows the first letter of up to two words", () => {
    expect(machineInitials("home-server")).toBe("HS");
    expect(machineInitials("Mac")).toBe("M");
    expect(machineInitials("mac.mini.local")).toBe("MM");
  });
});
