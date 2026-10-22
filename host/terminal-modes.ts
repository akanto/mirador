/** A switch of DEC private modes or of the keypad's mode, or a reset putting modes back as a terminal starts them. */
const modeSequence = /\x1b\[\?(?<modes>[\d;]*)(?<setOrReset>[hl])|\x1b(?<keypad>[=>])|(?<fullReset>\x1bc)|(?<softReset>\x1b\[!p)/g;

/** The start of such a sequence a chunk cut in two, at the text's end; the chunk after it brings the rest. */
const unfinishedSequence = /\x1b(?:\[(?:\?[\d;]{0,32}|!)?)?$/;

const KEYPAD = "keypad";

/**
 * What xterm.js's soft reset puts back: cursor and keypad keys, bracketed paste, cursor blink and visibility, origin
 * mode, wraparound, reverse wraparound, focus reports and synchronized output. The screen and the mouse stay as they are.
 */
const SOFT_RESET_MODES = ["1", KEYPAD, "2004", "12", "25", "6", "7", "45", "1004", "2026"];

/**
 * The modes output switched, each as it last switched it, in the order of those last switches. A terminal that replays
 * only the output after it switches them first, or it would not be in them: a full-screen program switches application
 * cursor keys on once as it starts, and without them the arrow keys send what the program doesn't read as arrows.
 */
export class SwitchedModes {
  private readonly latest = new Map<string, string>();
  private carry = "";

  read(output: string) {
    const reading = this.carry + output;
    for (const { groups } of reading.matchAll(modeSequence)) {
      const { modes, setOrReset, keypad, fullReset, softReset } = groups!;
      if (fullReset) this.latest.clear();
      else if (softReset) SOFT_RESET_MODES.forEach((mode) => this.latest.delete(mode));
      else if (keypad) this.switched(KEYPAD, `\x1b${keypad}`);
      else modes!.split(";").filter(Boolean).forEach((mode) => this.switched(mode, `\x1b[?${mode}${setOrReset}`));
    }
    this.carry = unfinishedSequence.exec(reading)?.[0] ?? "";
  }

  get switches() {
    return [...this.latest.values()].join("");
  }

  private switched(mode: string, sequence: string) {
    this.latest.delete(mode);
    this.latest.set(mode, sequence);
  }
}
