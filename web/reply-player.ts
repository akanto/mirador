import { useSyncExternalStore } from "react";
import type { StoredEvent } from "../shared/model.ts";
import type { TimelineBlock } from "../shared/timeline.ts";
import { speaksReplies, type VoiceSettings } from "../shared/voice.ts";

/** A reply being read aloud, by its timeline block's key: summed up first, then spoken a sentence at a time. */
export interface ReplyReading {
  conversationId: string;
  key: string;
  phase: "summing-up" | "speaking";
}

interface ReadingProblem {
  conversationId: string;
  key: string;
  problem: string;
}

interface Snapshot {
  reading: ReplyReading | null;
  problem: ReadingProblem | null;
}

/** The conversation whose last message this page dictated, and the last event it had when sending it. */
interface AwaitedReply {
  conversationId: string;
  afterSeq: number;
}

const RESUME_WAIT_MS = 500;
const MAX_KEPT_SUMMARIES = 20;

export const AUDIO_BLOCKED = "The browser didn't let Mirador play sound. The reply's play button reads it aloud.";

let context: AudioContext | null = null;
let snapshot: Snapshot = { reading: null, problem: null };
let stopCurrent: (() => void) | null = null;
let awaited: AwaitedReply | null = null;
const listeners = new Set<() => void>();

/** A reply's summary and its sentences' sound, kept so that hearing it again starts at once, in the same words. */
interface KeptSummary {
  sentences: string[];
  sounds: AudioBuffer[];
}

/** By reply and by how replies are read, so that other settings make a summary of their own; the least recently heard go first. */
const keptSummaries = new Map<string, KeptSummary>();

function keptSummary(id: string) {
  const kept = keptSummaries.get(id);
  if (!kept) return null;
  keptSummaries.delete(id);
  keptSummaries.set(id, kept);
  return kept;
}

function keep(id: string, summary: KeptSummary) {
  keptSummaries.set(id, summary);
  if (keptSummaries.size > MAX_KEPT_SUMMARIES) keptSummaries.delete(keptSummaries.keys().next().value!);
  return summary;
}

/** What a reply's summary and sound depend on; null when replies aren't read aloud. */
export const replyReadingOf = (settings: VoiceSettings) => {
  const { voiceModel, replyVoice, replyLanguage } = settings;
  return speaksReplies(settings) ? JSON.stringify({ voiceModel, replyVoice, replyLanguage }) : null;
};

function publish(next: Partial<Snapshot>) {
  snapshot = { ...snapshot, ...next };
  listeners.forEach((listener) => listener());
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useReplyReading = () => useSyncExternalStore(subscribe, () => snapshot);

/** Called in a press or click: a browser lets a page start sound later, as when a reply ends, only once a gesture has let it. */
export function allowReplyAudio() {
  context ??= new AudioContext();
  if (context.state === "suspended") void context.resume();
}

const problemOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function posted(conversationId: string, path: string, text: string, signal: AbortSignal) {
  let response: Response;
  try {
    response = await fetch(`/conversations/${conversationId}/${path}`, { method: "POST", headers: { "Content-Type": "text/plain; charset=utf-8" }, body: text, signal });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error(`The reply didn't reach Mirador to be read aloud: ${problemOf(error)}`);
  }
  if (!response.ok) throw new Error((await response.text()) || `Reading the reply aloud failed (${response.status}).`);
  return response;
}

async function summary(conversationId: string, reply: string, signal: AbortSignal) {
  const { sentences } = (await (await posted(conversationId, "reply-summary", reply, signal)).json()) as { sentences: string[] };
  return sentences;
}

/** Kept only once it says something, so that hearing the reply again asks the voice model again. */
async function sayable(conversationId: string, reply: string, signal: AbortSignal) {
  const sentences = await summary(conversationId, reply, signal);
  if (sentences.length === 0) throw new Error("The voice model found nothing in the reply to say.");
  return sentences;
}

async function spokenSentence(conversationId: string, sentence: string, signal: AbortSignal) {
  const sound = await (await posted(conversationId, "spoken-sentence", sentence, signal)).arrayBuffer();
  return context!.decodeAudioData(sound);
}

/** Safari suspends sound in a page left in the background; a browser that won't let it resume until a gesture says so. */
async function audible() {
  if (context!.state !== "running") await Promise.race([context!.resume(), new Promise((resolve) => setTimeout(resolve, RESUME_WAIT_MS))]);
  if (context!.state !== "running") throw new Error(AUDIO_BLOCKED);
}

async function played(sound: AudioBuffer, onSource: (source: AudioBufferSourceNode) => void) {
  await audible();
  return new Promise<void>((resolve) => {
    const source = context!.createBufferSource();
    source.buffer = sound;
    source.connect(context!.destination);
    source.onended = () => resolve();
    onSource(source);
    source.start();
  });
}

/** Made while the sentence before it plays, so that the reply is heard as one; a sentence never awaited fails quietly. */
function inAdvance<T>(making: Promise<T>) {
  making.catch(() => {});
  return making;
}

/** Sums the reply up and speaks it, starting as soon as the first sentence is ready; reading another reply stops this one. */
export async function readReply(conversationId: string, key: string, reply: string, readingAs: string) {
  stopReading();
  allowReplyAudio();
  const aborts = new AbortController();
  let source: AudioBufferSourceNode | null = null;
  const stop = () => {
    aborts.abort();
    source?.stop();
  };
  stopCurrent = stop;
  const reading: ReplyReading = { conversationId, key, phase: "summing-up" };
  publish({ reading, problem: null });
  try {
    const id = JSON.stringify([conversationId, key, reply, readingAs]);
    const { sentences, sounds } = keptSummary(id) ?? keep(id, { sentences: await sayable(conversationId, reply, aborts.signal), sounds: [] });
    const soundOf = async (index: number) => (sounds[index] ??= await spokenSentence(conversationId, sentences[index]!, aborts.signal));
    let next = inAdvance(soundOf(0));
    for (const index of sentences.keys()) {
      const sound = await next;
      if (index + 1 < sentences.length) next = inAdvance(soundOf(index + 1));
      if (aborts.signal.aborted) return;
      if (snapshot.reading?.phase !== "speaking") publish({ reading: { ...reading, phase: "speaking" } });
      await played(sound, (playing) => (source = playing));
      if (aborts.signal.aborted) return;
    }
  } catch (error) {
    if (!aborts.signal.aborted) publish({ problem: { conversationId, key, problem: problemOf(error) } });
  } finally {
    if (stopCurrent === stop) {
      stopCurrent = null;
      publish({ reading: null });
    }
  }
}

export function stopReading() {
  stopCurrent?.();
}

/** As when the user switches away from the conversation: a reply of another conversation reads on. */
export function stopReadingIn(conversationId: string) {
  if (snapshot.reading?.conversationId === conversationId) stopReading();
  if (awaited?.conversationId === conversationId) awaited = null;
}

/** The turn the message starts gets its last reply read aloud when it ends. */
export function awaitSpokenReply(conversationId: string, events: StoredEvent[]) {
  awaited = { conversationId, afterSeq: events.at(-1)?.seq ?? 0 };
}

/** As when a message the user typed starts the conversation's next turn; another pane's dictated message still gets its reply read. */
export function forgetSpokenReply(conversationId: string) {
  if (awaited?.conversationId === conversationId) awaited = null;
}

export type SpokenTurn = "going-on" | "ended" | "stopped";

/** How the first turn after the dictated message went, once it holds the message. */
export function spokenTurn(events: StoredEvent[], afterSeq: number): SpokenTurn {
  const since = events.filter(({ seq }) => seq > afterSeq);
  const asked = since.findIndex(({ event }) => event.type === "user-message");
  if (asked === -1) return "going-on";
  const ended = since.slice(asked + 1).find(({ event }) => event.type === "turn-end" || event.type === "error");
  if (!ended) return "going-on";
  return ended.event.type === "turn-end" && ended.event.stopReason === "end_turn" ? "ended" : "stopped";
}

/** The turn's last reply, which its play button reads too; none when the agent wrote nothing after the user's last message. */
export function lastReply(timeline: TimelineBlock[]) {
  const lastAsked = timeline.findLastIndex(({ kind }) => kind === "user");
  const reply = timeline.findLast((block, index) => index > lastAsked && block.kind === "agent");
  return reply?.kind === "agent" ? reply : null;
}

/** Reads the last reply aloud once the turn a dictated message started ends, for the page that dictated it. */
export function readWhenSpokenTurnEnds(conversationId: string, events: StoredEvent[], timeline: TimelineBlock[], readingAs: string | null) {
  if (awaited?.conversationId !== conversationId) return;
  const outcome = spokenTurn(events, awaited.afterSeq);
  if (outcome === "going-on") return;
  awaited = null;
  const reply = outcome === "ended" ? lastReply(timeline) : null;
  if (reply && readingAs) void readReply(conversationId, reply.key, reply.text, readingAs);
}
