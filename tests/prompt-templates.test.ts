import { describe, expect, test } from "bun:test";
import { defaultPromptTemplates, filledIn, parametersOf, promptTemplateProblem } from "../shared/prompt-templates.ts";

describe("prompt templates", () => {
  test("ask for each {{parameter}} once, in the order it first appears, spaces around its name ignored", () => {
    expect(parametersOf("Review {{ Pull request }} against {{Base}}; post on {{Pull request}}. {{}} {single}")).toEqual(["Pull request", "Base"]);
    expect(parametersOf("No parameters")).toEqual([]);
  });

  test("fill every place a parameter is in, and leave text that only looks like one", () => {
    const text = "Review {{ Pull request }} against {{Base}}; post on {{Pull request}}. {{}} {single}";
    expect(filledIn(text, { "Pull request": "https://github.com/o/r/pull/5", Base: "main" })).toBe(
      "Review https://github.com/o/r/pull/5 against main; post on https://github.com/o/r/pull/5. {{}} {single}",
    );
    expect(filledIn(text, {})).toBe("Review  against ; post on . {{}} {single}");
  });

  test("need a name and a text, within their limits", () => {
    expect(promptTemplateProblem({ id: "t", name: "Review", text: "x" })).toBeNull();
    expect(promptTemplateProblem({ id: "t", name: "  ", text: "x" })).toBe("A template needs a name.");
    expect(promptTemplateProblem({ id: "t", name: "Review", text: " \n" })).toBe("A template needs a text.");
    expect(promptTemplateProblem({ id: "", name: "Review", text: "x" })).toBe("A template needs an id.");
    expect(promptTemplateProblem({ id: "t", name: "Review", text: "x".repeat(20_001) })).toMatch(/at most 20000 characters/);
  });

  test("the default deep review asks for the pull request", () => {
    expect(defaultPromptTemplates.map(({ name, text }) => [name, parametersOf(text)])).toEqual([["Deep PR review", ["Pull request"]]]);
  });
});
