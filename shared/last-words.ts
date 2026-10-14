import type { StoredEvent } from "./model.ts";
import { lastGraphemes } from "./text-cut.ts";
import { buildTimeline } from "./timeline.ts";

/** A few lines on a phone's Waiting card. */
export const LAST_WORDS_GRAPHEMES = 400;

/** Where a message cut from the front reads on cleanly: at its next line, else its next word, when one comes early on. */
function cleanStart(kept: string) {
  const earlyOn = kept.length / 2;
  const nextLine = kept.indexOf("\n");
  if (nextLine !== -1 && nextLine < earlyOn) return nextLine + 1;
  const nextWord = kept.search(/\s/);
  return nextWord !== -1 && nextWord < earlyOn ? nextWord + 1 : 0;
}

/**
 * The end of what the agent said last in a turn's events, for a Waiting card to show: its last message, cut from the
 * front after an ellipsis when long; null when the agent said nothing in words.
 */
export function lastWordsOf(turn: StoredEvent[]): string | null {
  const last = buildTimeline(turn).findLast(({ kind }) => kind === "agent");
  const message = last?.kind === "agent" ? last.text.trim() : "";
  if (!message) return null;
  const kept = lastGraphemes(message, LAST_WORDS_GRAPHEMES);
  return kept === message ? message : `…${kept.slice(cleanStart(kept)).trimStart()}`;
}
