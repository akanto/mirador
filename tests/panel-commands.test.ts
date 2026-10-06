import { describe, expect, test } from "bun:test";
import { panelCommandLine, panelCommandRun, refusedPanelCommand } from "../shared/panel-commands.ts";

describe("panelCommandLine", () => {
  test("takes a panel command, with whatever follows it", () => {
    expect(panelCommandLine("/plugin")).toBe("/plugin");
    expect(panelCommandLine("  /plugin install some-plugin@some-marketplace  ")).toBe("/plugin install some-plugin@some-marketplace");
  });

  test("leaves the agent's own commands and anything else alone", () => {
    expect(panelCommandLine("/compact")).toBeNull();
    expect(panelCommandLine("/plugins")).toBeNull();
    expect(panelCommandLine("what does /plugin do?")).toBeNull();
  });
});

describe("panelCommandRun", () => {
  test("takes both paths to the terminal, listed and refused alike", () => {
    expect(panelCommandRun(panelCommandLine("/plugin")!)).toBe("/plugin");
    expect(panelCommandRun("/plugin install some-plugin@some-marketplace")).toBe("/plugin install some-plugin@some-marketplace");
    expect(panelCommandRun(`/${refusedPanelCommand("/things-to-come isn't available in this environment.")!}`)).toBe("/things-to-come");
  });

  test("refuses anything that would run Claude Code with arguments of the sender's own choosing", () => {
    expect(panelCommandRun("--dangerously-skip-permissions")).toBeNull();
    expect(panelCommandRun("-p /plugin")).toBeNull();
    expect(panelCommandRun("/usr/local/bin/claude /plugin")).toBeNull();
    expect(panelCommandRun("/plugin\n--dangerously-skip-permissions")).toBeNull();
    expect(panelCommandRun("")).toBeNull();
  });
});

describe("refusedPanelCommand", () => {
  test("names the command Claude Code refused", () => {
    expect(refusedPanelCommand("/plugin isn't available in this environment.")).toBe("plugin");
    expect(refusedPanelCommand("/hooks isn't available in this environment.")).toBe("hooks");
  });

  test("names one the list does not have, which is what makes it a backstop for a later Claude Code", () => {
    expect(refusedPanelCommand("/things-to-come isn't available in this environment.")).toBe("things-to-come");
  });

  test("leaves a message that only mentions a refusal alone", () => {
    expect(refusedPanelCommand("It said /plugin isn't available in this environment.")).toBeNull();
    expect(refusedPanelCommand("/plugin opened its panel.")).toBeNull();
  });
});
