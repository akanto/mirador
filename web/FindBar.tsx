import { createContext, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type KeyboardEvent, type RefObject } from "react";
import { focusPane } from "./actions.ts";
import { matchCount, matchOffsets, occurrencesIn } from "../shared/find.ts";
import { hints } from "./hints.ts";
import type { TimelineBlock } from "../shared/timeline.ts";

/** The query while the find bar is open, so that output folded away unfolds where it matches. */
export const FindQuery = createContext("");

/** A search hit to show: its conversation opens with the find bar on the hit's entry. */
interface FindRequest {
  conversationId: string;
  query: string;
  entryKey: string;
}

let waitingRequest: FindRequest | null = null;
const requestListeners = new Set<() => void>();
const requestChanged = () => requestListeners.forEach((listener) => listener());
const subscribeToRequests = (listener: () => void) => {
  requestListeners.add(listener);
  return () => requestListeners.delete(listener);
};

export function requestFind(request: FindRequest) {
  waitingRequest = request;
  requestChanged();
}

function takeFindRequest() {
  waitingRequest = null;
  requestChanged();
}

interface Place {
  entry: number;
  occurrence: number;
}

/** An entry with matches: how many, and its element while it is in the page, where they are found as rendered. */
interface EntryMatches {
  entry: number;
  count: number;
  element: Element | null;
}

/** Highlighting creates a range per match, and every range slows each later change of the page. */
const MAX_HIGHLIGHTED = 1_000;

function textNodesOf(entry: Element) {
  const walker = document.createTreeWalker(entry.querySelector(".entry-body") ?? entry, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement?.closest(".author") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  return nodes;
}

/** The entry's text is read as one string, so a match may span the elements that markdown and code highlighting split it into. */
function entryText(entry: Element) {
  let length = 0;
  const pieces = textNodesOf(entry).map((node) => {
    const start = length;
    length += node.data.length;
    return { node, start };
  });
  return { pieces, text: pieces.map(({ node }) => node.data).join("") };
}

function rangesIn(entry: Element, query: string, limit: number): Range[] {
  const { pieces, text } = entryText(entry);
  const at = (offset: number, holds: (start: number) => boolean) => {
    const piece = pieces.findLast(({ start }) => holds(start))!;
    return [piece.node, offset - piece.start] as const;
  };
  return matchOffsets(text, query)
    .slice(0, limit)
    .map(([start, end]) => {
      const range = document.createRange();
      range.setStart(...at(start, (pieceStart) => pieceStart <= start));
      range.setEnd(...at(end, (pieceStart) => pieceStart < end));
      return range;
    });
}

const rangeAt = (entry: Element, query: string, occurrence: number) => rangesIn(entry, query, occurrence + 1)[occurrence] ?? null;

const loadedEntries = (timeline: HTMLElement) => [...timeline.querySelectorAll(":scope > .timeline-entry")];

function visibleMatches(timeline: HTMLElement, query: string) {
  const view = timeline.getBoundingClientRect();
  return loadedEntries(timeline)
    .filter((entry) => {
      const box = entry.getBoundingClientRect();
      return box.bottom > view.top && box.top < view.bottom;
    })
    .flatMap((entry) => rangesIn(entry, query, MAX_HIGHLIGHTED))
    .slice(0, MAX_HIGHLIGHTED);
}

/** Opens the folded cards a match is in, but not a card whose title it is in. */
function unfoldAround(range: Range) {
  const node = range.startContainer;
  for (let details = node.parentElement?.closest("details"); details; details = details.parentElement?.closest("details")) {
    if (!details.querySelector(":scope > summary")?.contains(node)) details.open = true;
  }
}

function scrollToMiddle(timeline: HTMLElement, range: Range) {
  const match = range.getBoundingClientRect();
  timeline.scrollTop += match.top - timeline.getBoundingClientRect().top - (timeline.clientHeight - match.height) / 2;
}

const canHighlight = typeof CSS !== "undefined" && "highlights" in CSS;

function highlight(ranges: Range[], current: Range) {
  if (!canHighlight) return;
  const matches = new Highlight();
  ranges.forEach((range) => matches.add(range));
  CSS.highlights.set("find-match", matches);
  CSS.highlights.set("find-current", new Highlight(current));
}

function clearHighlights() {
  if (!canHighlight) return;
  CSS.highlights.delete("find-match");
  CSS.highlights.delete("find-current");
}

const lastIn = ({ entry, count }: EntryMatches): Place => ({ entry, occurrence: count - 1 });

/**
 * The match at the wanted place, else the one before it, as when the entry rendered fewer matches than its stored text
 * has, else the first; with no place wanted, the newest.
 */
function placeOf(entries: EntryMatches[], wanted: Place | null): Place | null {
  if (entries.length === 0) return null;
  if (!wanted) return lastIn(entries.at(-1)!);
  const holder = entries.find(({ entry }) => entry === wanted.entry);
  if (holder) return wanted.occurrence < holder.count ? wanted : lastIn(holder);
  const before = entries.findLast(({ entry }) => entry < wanted.entry);
  return before ? lastIn(before) : { entry: entries[0]!.entry, occurrence: 0 };
}

const positionOf = (entries: EntryMatches[], place: Place) =>
  entries.filter(({ entry }) => entry < place.entry).reduce((before, { count }) => before + count, 0) + place.occurrence + 1;

function stepped(entries: EntryMatches[], place: Place, direction: 1 | -1): Place {
  const index = entries.findIndex(({ entry }) => entry === place.entry);
  const occurrence = place.occurrence + direction;
  if (occurrence >= 0 && occurrence < entries[index]!.count) return { entry: place.entry, occurrence };
  const next = entries[(index + direction + entries.length) % entries.length]!;
  return direction === 1 ? { entry: next.entry, occurrence: 0 } : lastIn(next);
}

/**
 * Finds the query in the whole conversation. Entries in the page are searched as rendered; those not loaded yet by
 * their stored text, and loaded once a step reaches them. The first match shown is the newest.
 */
export function useFind({
  conversationId,
  historyLoaded,
  timeline,
  timelineRef,
  firstLoaded,
  loadFrom,
}: {
  conversationId: string;
  historyLoaded: boolean;
  timeline: TimelineBlock[];
  timelineRef: RefObject<HTMLDivElement | null>;
  firstLoaded: number;
  loadFrom: (index: number) => void;
}) {
  const [query, setQuery] = useState<string | null>(null);
  const [tally, setTally] = useState({ position: 0, total: 0 });
  const [placeChanges, showPlace] = useReducer((count: number) => count + 1, 0);
  const place = useRef<Place | null>(null);
  const placeShown = useRef<string | null>(null);
  const withMatches = useRef<EntryMatches[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const storedCounts = useMemo(() => new Map<string, number>(), [query]);

  const request = useSyncExternalStore(subscribeToRequests, () => waitingRequest);
  useEffect(() => {
    if (request?.conversationId !== conversationId || !historyLoaded) return;
    takeFindRequest();
    const entry = timeline.findIndex(({ key }) => key === request.entryKey);
    place.current = entry === -1 ? null : { entry, occurrence: 0 };
    placeShown.current = null;
    setQuery(request.query);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [request, historyLoaded]);

  const countStored = (block: TimelineBlock) => {
    if (!storedCounts.has(block.key)) storedCounts.set(block.key, occurrencesIn(block, query!));
    return storedCounts.get(block.key)!;
  };

  useEffect(() => {
    const element = timelineRef.current;
    if (!query || !element) {
      withMatches.current = [];
      return;
    }
    const entries: EntryMatches[] = [
      ...timeline.slice(0, firstLoaded).map((block, entry) => ({ entry, count: countStored(block), element: null })),
      ...loadedEntries(element).map((entryElement, offset) => ({
        entry: firstLoaded + offset,
        count: matchCount(entryText(entryElement).text, query),
        element: entryElement,
      })),
    ].filter(({ count }) => count > 0);
    withMatches.current = entries;
    const current = placeOf(entries, place.current);
    const total = entries.reduce((sum, { count }) => sum + count, 0);
    const position = current ? positionOf(entries, current) : 0;
    setTally((shown) => (shown.position === position && shown.total === total ? shown : { position, total }));
    if (!current) return;
    place.current = current;
    const holder = entries.find(({ entry }) => entry === current.entry)!;
    if (!holder.element) return loadFrom(current.entry);
    const currentRange = rangeAt(holder.element, query, current.occurrence);
    if (!currentRange) return;
    const placeKey = `${current.entry}:${current.occurrence}`;
    if (placeShown.current !== placeKey) {
      placeShown.current = placeKey;
      unfoldAround(currentRange);
      scrollToMiddle(element, currentRange);
    }
    const highlightVisible = () => highlight(visibleMatches(element, query), currentRange);
    highlightVisible();
    let frame = 0;
    const highlightOnScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(highlightVisible);
    };
    element.addEventListener("scroll", highlightOnScroll, { passive: true });
    return () => {
      element.removeEventListener("scroll", highlightOnScroll);
      cancelAnimationFrame(frame);
      clearHighlights();
    };
  }, [query, timeline, firstLoaded, placeChanges]);

  const search = (text: string) => {
    place.current = null;
    placeShown.current = null;
    setQuery(text);
  };
  const step = (direction: 1 | -1) => {
    const entries = withMatches.current;
    const current = placeOf(entries, place.current);
    if (!current) return;
    place.current = stepped(entries, current, direction);
    showPlace();
  };
  const open = () => {
    setQuery((open) => open ?? "");
    requestAnimationFrame(() => inputRef.current?.select());
  };
  const close = () => {
    place.current = null;
    placeShown.current = null;
    setQuery(null);
    focusPane("chat");
  };
  return { query, tally, search, step, open, close, inputRef };
}

export type Find = ReturnType<typeof useFind>;

export function FindBar({ find: { query, tally, search, step, close, inputRef } }: { find: Find }) {
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      step(event.shiftKey ? 1 : -1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  };
  return (
    <div className="find-bar" role="search">
      <input
        ref={inputRef}
        autoFocus
        value={query ?? ""}
        onChange={(event) => search(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Find in this conversation"
        aria-label="Find in this conversation"
        spellCheck={false}
        autoComplete="off"
      />
      <span className="find-tally" aria-live="polite">
        {query ? (tally.total > 0 ? `${tally.position} of ${tally.total}` : "No matches") : ""}
      </span>
      <button type="button" className="icon" aria-label="Older match" data-hint={hints.findOlder} disabled={tally.total === 0} onClick={() => step(-1)}>
        ↑
      </button>
      <button type="button" className="icon" aria-label="Newer match" data-hint={hints.findNewer} disabled={tally.total === 0} onClick={() => step(1)}>
        ↓
      </button>
      <button type="button" className="icon" aria-label="Close find" onClick={close}>
        ×
      </button>
    </div>
  );
}
