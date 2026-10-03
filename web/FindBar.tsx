import { createContext, useEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { focusPane } from "./actions.ts";
import { matchOffsets, occurrencesIn } from "./find.ts";
import { hints } from "./hints.ts";
import type { TimelineBlock } from "./timeline.ts";

/** The query while the find bar is open, so that output folded away unfolds where it matches. */
export const FindQuery = createContext("");

interface Place {
  entry: number;
  occurrence: number;
}

/** A match in an entry not in the page has no range until the entry is loaded. */
interface Match extends Place {
  range: Range | null;
}

function textNodesOf(entry: Element) {
  const walker = document.createTreeWalker(entry.querySelector(".entry-body") ?? entry, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement?.closest(".author") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  return nodes;
}

/** The entry's text is read as one string, so a match may span the elements that markdown and code highlighting split it into. */
function rangesIn(entry: Element, query: string): Range[] {
  let length = 0;
  const pieces = textNodesOf(entry).map((node) => {
    const start = length;
    length += node.data.length;
    return { node, start };
  });
  const text = pieces.map(({ node }) => node.data).join("");
  const at = (offset: number, holds: (start: number) => boolean) => {
    const piece = pieces.findLast(({ start }) => holds(start))!;
    return [piece.node, offset - piece.start] as const;
  };
  return matchOffsets(text, query).map(([start, end]) => {
    const range = document.createRange();
    range.setStart(...at(start, (pieceStart) => pieceStart <= start));
    range.setEnd(...at(end, (pieceStart) => pieceStart < end));
    return range;
  });
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
  CSS.highlights.set("find-match", new Highlight(...ranges));
  CSS.highlights.set("find-current", new Highlight(current));
}

function clearHighlights() {
  if (!canHighlight) return;
  CSS.highlights.delete("find-match");
  CSS.highlights.delete("find-current");
}

/** The match at the wanted place, else the one before it, as when the entry rendered fewer matches than its stored text has. */
function indexOf(matches: Match[], wanted: Place | null) {
  if (!wanted) return matches.length - 1;
  const exact = matches.findIndex(({ entry, occurrence }) => entry === wanted.entry && occurrence === wanted.occurrence);
  if (exact >= 0) return exact;
  return Math.max(0, matches.findLastIndex(({ entry, occurrence }) => entry < wanted.entry || (entry === wanted.entry && occurrence < wanted.occurrence)));
}

/**
 * Finds the query in the whole conversation. Entries in the page are searched as rendered; those not loaded yet by
 * their stored text, and loaded once a step reaches them. The first match shown is the newest.
 */
export function useFind({
  timeline,
  timelineRef,
  firstLoaded,
  loadFrom,
}: {
  timeline: TimelineBlock[];
  timelineRef: RefObject<HTMLDivElement | null>;
  firstLoaded: number;
  loadFrom: (index: number) => void;
}) {
  const [query, setQuery] = useState<string | null>(null);
  const [tally, setTally] = useState({ position: 0, total: 0 });
  const [, showPlace] = useReducer((count: number) => count + 1, 0);
  const place = useRef<Place | null>(null);
  const placeShown = useRef<string | null>(null);
  const matches = useRef<Match[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const storedCounts = useMemo(() => new Map<string, number>(), [query]);

  const countStored = (block: TimelineBlock) => {
    if (!storedCounts.has(block.key)) storedCounts.set(block.key, occurrencesIn(block, query!));
    return storedCounts.get(block.key)!;
  };

  useEffect(() => {
    const element = timelineRef.current;
    if (!query || !element) {
      matches.current = [];
      return;
    }
    const notLoaded = timeline
      .slice(0, firstLoaded)
      .flatMap((block, entry) => Array.from({ length: countStored(block) }, (_, occurrence): Match => ({ entry, occurrence, range: null })));
    const loaded = [...element.querySelectorAll(":scope > .timeline-entry")].flatMap((entryElement, offset) =>
      rangesIn(entryElement, query).map((range, occurrence): Match => ({ entry: firstLoaded + offset, occurrence, range })),
    );
    const all = [...notLoaded, ...loaded];
    matches.current = all;
    const index = indexOf(all, place.current);
    const current = all[index];
    setTally((shown) => (shown.position === index + 1 && shown.total === all.length ? shown : { position: index + 1, total: all.length }));
    if (!current) return;
    place.current = { entry: current.entry, occurrence: current.occurrence };
    if (!current.range) return loadFrom(current.entry);
    highlight(
      loaded.map(({ range }) => range!),
      current.range,
    );
    const placeKey = `${current.entry}:${current.occurrence}`;
    if (placeShown.current !== placeKey) {
      placeShown.current = placeKey;
      unfoldAround(current.range);
      scrollToMiddle(element, current.range);
    }
    return clearHighlights;
  });

  const search = (text: string) => {
    place.current = null;
    placeShown.current = null;
    setQuery(text);
  };
  const step = (direction: 1 | -1) => {
    const all = matches.current;
    if (all.length === 0) return;
    const next = all[(indexOf(all, place.current) + direction + all.length) % all.length]!;
    place.current = { entry: next.entry, occurrence: next.occurrence };
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
