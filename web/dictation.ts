import type { VoiceSettings } from "../shared/voice.ts";
import type { EngineServer, EngineServerState } from "../shared/voice-engine.ts";

/** A press let go of sooner than this is a tap: listening goes on until a pause or the next press. */
export const HOLD_MS = 400;

export type Press = { kind: "up" } | { kind: "down"; at: number } | { kind: "tapped" };
type PressAction = "start" | "finish" | null;

export function pressed(press: Press, at: number): { press: Press; action: PressAction } {
  if (press.kind === "up") return { press: { kind: "down", at }, action: "start" };
  if (press.kind === "tapped") return { press: { kind: "up" }, action: "finish" };
  return { press, action: null };
}

export function released(press: Press, at: number): { press: Press; action: PressAction } {
  if (press.kind !== "down") return { press, action: null };
  return at - press.at < HOLD_MS ? { press: { kind: "tapped" }, action: null } : { press: { kind: "up" }, action: "finish" };
}

export type DictationPhase = "idle" | "listening" | "transcribing";

export function dictationStatus(phase: DictationPhase, settings: VoiceSettings, servers: Record<EngineServer, EngineServerState>) {
  if (phase === "idle") return null;
  if (phase === "listening") return "Listening… It stops when you pause or let go. Esc cancels.";
  if (settings.recognition.kind === "this-mac" && servers.speech !== "ready") return "Loading speech recognition on this Mac…";
  if (settings.voiceModel.kind === "this-mac" && servers.voiceModel === "loading") return "Loading the voice model on this Mac…";
  return "Turning speech into text…";
}

/** What was said goes in as words of their own, with a space between them and the text on either side. */
export function spacedAtCaret(text: string, start: number, end: number, words: string) {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const spaceBefore = before !== "" && !/\s$/.test(before) ? " " : "";
  const spaceAfter = after !== "" && !/^\s/.test(after) ? " " : "";
  return spaceBefore + words.trim() + spaceAfter;
}
