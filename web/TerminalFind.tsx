import type { ISearchResultChangeEvent, SearchAddon } from "@xterm/addon-search";
import { useEffect, useState, type KeyboardEvent, type MouseEvent, type RefObject } from "react";
import { hints } from "./hints.ts";
import { findTally, isSearchable, noToggles, searchOptions, type FindToggles } from "./terminal-find.ts";
import { terminalKeyAction } from "./terminal-keys.ts";

const toggleButtons: { toggle: keyof FindToggles; label: string; name: string; hint: string }[] = [
  { toggle: "caseSensitive", label: "Aa", name: "Match case", hint: hints.terminalFindCase },
  { toggle: "wholeWord", label: "ab", name: "Match whole word", hint: hints.terminalFindWholeWord },
  { toggle: "regex", label: ".*", name: "Use regular expression", hint: hints.terminalFindRegex },
];

/** Clicking a button leaves the caret in the query, so Enter goes on stepping through the matches. */
const keepsFocusInQuery = (event: MouseEvent) => event.preventDefault();

/** Finds in a terminal's scrollback: every match highlighted, and the current one selected and scrolled to. */
export function TerminalFind({ search, inputRef, onClose }: { search: SearchAddon; inputRef: RefObject<HTMLInputElement | null>; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [toggles, setToggles] = useState(noToggles);
  const [results, setResults] = useState<ISearchResultChangeEvent | null>(null);
  const searchable = isSearchable(query, toggles);

  useEffect(() => {
    const listening = search.onDidChangeResults(setResults);
    return () => {
      listening.dispose();
      search.clearDecorations();
    };
  }, [search]);

  useEffect(() => {
    // The addon compares a search's options with ones it has already stored, so only a forgotten term makes it highlight again.
    search.clearDecorations();
    setResults(null);
    if (searchable) search.findPrevious(query, searchOptions(toggles));
  }, [search, query, toggles]);

  const step = (direction: "up" | "down") => {
    if (!searchable) return;
    if (direction === "up") search.findPrevious(query, searchOptions(toggles));
    else search.findNext(query, searchOptions(toggles));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      step(event.shiftKey ? "down" : "up");
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (terminalKeyAction(event.nativeEvent)?.type === "find") {
      event.preventDefault();
      event.currentTarget.select();
    }
  };

  return (
    <div className="terminal-find" role="search">
      <input
        ref={inputRef}
        autoFocus
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Find"
        aria-label="Find in this terminal"
        spellCheck={false}
        autoComplete="off"
      />
      {toggleButtons.map(({ toggle, label, name, hint }) => (
        <button
          key={toggle}
          type="button"
          className={`find-toggle ${toggle}${toggles[toggle] ? " on" : ""}`}
          aria-label={name}
          aria-pressed={toggles[toggle]}
          data-hint={hint}
          onMouseDown={keepsFocusInQuery}
          onClick={() => setToggles((current) => ({ ...current, [toggle]: !current[toggle] }))}
        >
          {label}
        </button>
      ))}
      <span className="find-tally" aria-live="polite">
        {findTally(query, toggles, results)}
      </span>
      <button type="button" className="icon" aria-label="Older match" data-hint={hints.findOlder} disabled={!searchable} onMouseDown={keepsFocusInQuery} onClick={() => step("up")}>
        ↑
      </button>
      <button type="button" className="icon" aria-label="Newer match" data-hint={hints.findNewer} disabled={!searchable} onMouseDown={keepsFocusInQuery} onClick={() => step("down")}>
        ↓
      </button>
      <button type="button" className="icon" aria-label="Close find" onClick={onClose}>
        ×
      </button>
    </div>
  );
}
