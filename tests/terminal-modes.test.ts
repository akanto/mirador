import { expect, test } from "bun:test";
import { SwitchedModes } from "../host/terminal-modes.ts";

const switchesAfter = (...chunks: string[]) => {
  const modes = new SwitchedModes();
  chunks.forEach((chunk) => modes.read(chunk));
  return modes.switches;
};

test("each mode comes back as the output last switched it, in the order of those last switches", () => {
  expect(switchesAfter("\x1b[?1h\x1b[?25l text \x1b[?1049h more\x1b[?1l")).toBe("\x1b[?25l\x1b[?1049h\x1b[?1l");
});

test("a switch of several modes at once comes back as one switch each", () => {
  expect(switchesAfter("\x1b[?1000;1006h")).toBe("\x1b[?1000h\x1b[?1006h");
});

test("the keypad's application and numeric modes are one mode", () => {
  expect(switchesAfter("\x1b[?1h\x1b=")).toBe("\x1b[?1h\x1b=");
  expect(switchesAfter("\x1b=\x1b[?1h\x1b>")).toBe("\x1b[?1h\x1b>");
});

test("a switch a chunk cut in two counts, wherever the cut fell", () => {
  const output = "before\x1b[?1049hafter\x1b=";
  [...output].forEach((_, cut) => expect(switchesAfter(output.slice(0, cut), output.slice(cut))).toBe("\x1b[?1049h\x1b="));
});

test("other escapes switch no mode", () => {
  expect(switchesAfter("\x1b[1A\x1b[?1$p\x1b[?2J\x1b]0;title\x07\x1b[31m")).toBe("");
});

test("a full reset forgets every mode switched before it", () => {
  expect(switchesAfter("\x1b[?1049h\x1b[?1h\x1b=\x1bc")).toBe("");
  expect(switchesAfter("\x1b[?1049h\x1bc\x1b[?2004h")).toBe("\x1b[?2004h");
});

test("a soft reset forgets the modes it puts back, but not the screen or the mouse", () => {
  expect(switchesAfter("\x1b[?1049h\x1b[?1000h\x1b[?1h\x1b[?2004h\x1b[?25l\x1b=\x1b[!p")).toBe("\x1b[?1049h\x1b[?1000h");
});
