import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { fontScales, FONT_SCALES, steppedFontScale, type FontScale } from "../web/font-scale.ts";
import {
  resetTerminalFontSize,
  setTerminalFontSize,
  stepTerminalFontSize,
  storedTerminalFontSize,
  subscribeTerminalFontSize,
  TERMINAL_FONT_SIZES,
  terminalFontSize,
} from "../web/terminal-font.ts";

describe("steppedFontScale", () => {
  test("steps up the 50% to 200% ladder", () => {
    expect(steppedFontScale("50", 1)).toBe("70");
    expect(steppedFontScale("70", 1)).toBe("100");
    expect(steppedFontScale("100", 1)).toBe("140");
    expect(steppedFontScale("140", 1)).toBe("200");
  });

  test("steps down the ladder", () => {
    expect(steppedFontScale("200", -1)).toBe("140");
    expect(steppedFontScale("140", -1)).toBe("100");
    expect(steppedFontScale("100", -1)).toBe("70");
    expect(steppedFontScale("70", -1)).toBe("50");
  });

  test("clamps at the ends so it cannot step beyond 50% or 200%", () => {
    expect(steppedFontScale("50", -1)).toBe("50");
    expect(steppedFontScale("200", 1)).toBe("200");
  });

  test("falls back to 100% when given an unknown scale", () => {
    expect(steppedFontScale("unknown" as FontScale, 1)).toBe("100");
  });

  test("defines five ladder steps with their scale factors", () => {
    expect(fontScales).toEqual(["50", "70", "100", "140", "200"]);
    expect(FONT_SCALES).toEqual({ "50": 0.5, "70": 0.7, "100": 1, "140": 1.4, "200": 2 });
  });
});

describe("terminal-font", () => {
  const originalLocalStorage = globalThis.localStorage;
  const storage = new Map<string, string>();

  beforeEach(() => {
    storage.clear();
    globalThis.localStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
      length: 0,
      key: () => null,
    } as unknown as Storage;
    resetTerminalFontSize();
  });

  afterAll(() => {
    globalThis.localStorage = originalLocalStorage;
  });

  test("valid sizes range from 11 to 24 px", () => {
    expect(TERMINAL_FONT_SIZES).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24]);
  });

  test("defaults to 12 px when nothing is stored", () => {
    expect(storedTerminalFontSize()).toBe(12);
    expect(terminalFontSize()).toBe(12);
  });

  test("storedTerminalFontSize ignores invalid or out-of-range values", () => {
    storage.set("mirador-terminal-font-size", "99");
    expect(storedTerminalFontSize()).toBe(12);
    storage.set("mirador-terminal-font-size", "10");
    expect(storedTerminalFontSize()).toBe(12);
    storage.set("mirador-terminal-font-size", "not-a-number");
    expect(storedTerminalFontSize()).toBe(12);
    storage.set("mirador-terminal-font-size", "14");
    expect(storedTerminalFontSize()).toBe(14);
  });

  test("setTerminalFontSize clamps to 11–24 px and persists", () => {
    setTerminalFontSize(16);
    expect(terminalFontSize()).toBe(16);
    expect(storage.get("mirador-terminal-font-size")).toBe("16");

    setTerminalFontSize(8);
    expect(terminalFontSize()).toBe(11);

    setTerminalFontSize(30);
    expect(terminalFontSize()).toBe(24);

    setTerminalFontSize(NaN);
    expect(terminalFontSize()).toBe(12);

    setTerminalFontSize(14.7);
    expect(terminalFontSize()).toBe(15);
  });

  test("stepTerminalFontSize steps single pixels and stays clamped", () => {
    setTerminalFontSize(12);
    stepTerminalFontSize(1);
    expect(terminalFontSize()).toBe(13);
    stepTerminalFontSize(-1);
    expect(terminalFontSize()).toBe(12);

    setTerminalFontSize(24);
    stepTerminalFontSize(1);
    expect(terminalFontSize()).toBe(24);

    setTerminalFontSize(11);
    stepTerminalFontSize(-1);
    expect(terminalFontSize()).toBe(11);
  });

  test("resetTerminalFontSize restores 12 px", () => {
    setTerminalFontSize(18);
    expect(terminalFontSize()).toBe(18);
    resetTerminalFontSize();
    expect(terminalFontSize()).toBe(12);
  });

  test("subscribeTerminalFontSize notifies listeners of size changes", () => {
    let notified = 0;
    const unsubscribe = subscribeTerminalFontSize(() => {
      notified++;
    });

    setTerminalFontSize(15);
    expect(notified).toBe(1);

    setTerminalFontSize(17);
    expect(notified).toBe(2);

    unsubscribe();
    setTerminalFontSize(19);
    expect(notified).toBe(2);
  });
});
