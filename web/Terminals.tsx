import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Fragment, useEffect, useReducer, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode, type RefObject } from "react";
import { MAX_TERMINALS_PER_TAB, type TabTerminal, type TerminalTab, type Workspace } from "../shared/model.ts";
import type { TerminalSplit } from "../shared/protocol.ts";
import { isTerminal, layoutKey, terminalsIn, type TerminalLayout } from "../shared/terminal-layout.ts";
import { ConfirmButton } from "./ConfirmButton.tsx";
import { connection, type ConnectionStatus } from "./connection.ts";
import { hints } from "./hints.ts";
import { takeProgramRequest, useProgramRequest, type ProgramRequest } from "./program-request.ts";
import { terminalShortcutKeys } from "./shortcuts.ts";
import { Splitter } from "./Splitter.tsx";
import { terminalKeyAction, type PaneCommand } from "./terminal-keys.ts";
import { TERMINAL_FONT, terminalTheme } from "./terminal-look.ts";
import { subscribeTerminalFontSize, terminalFontSize } from "./terminal-font.ts";
import { copiesOnSelect } from "./terminal-settings.ts";
import { terminalAfter, terminalToward, type PlacedTerminal } from "./terminal-navigation.ts";
import { FullscreenToggle, PaneGrip } from "./Workspace.tsx";

const INITIAL_COLUMNS = 80;
const INITIAL_ROWS = 24;
const MIN_SPLIT_SIZE = { columns: 120, rows: 80 };

interface FocusRequest {
  terminalId: string;
}

/** ⌘W met a terminal running `command`; a new one for each time, so its close button asks again each time. */
interface BusyClose {
  terminalId: string;
  command: string;
  /** Set when closing this whole tab was asked, as a middle-click does. */
  tabId?: string;
}

/** ⌘W on a tab's only terminal asks again on the tab's close, as a middle-click on the tab does. */
const tabCloseAsksAgain = (tab: TerminalTab, busy: BusyClose | null): busy is BusyClose =>
  busy !== null && (busy.tabId === undefined ? tab.terminals.length === 1 && tab.terminals[0]!.id === busy.terminalId : busy.tabId === tab.id);

const isMiddleButton = (event: MouseEvent) => event.button === 1;

/** What a terminal tells its pane: a pane key pressed in it, and that it got the keyboard focus. */
interface TerminalEvents {
  command: (command: PaneCommand, terminalId: string) => void;
  focused: (terminalId: string) => void;
}

const tabLabel = (tab: TerminalTab) => tab.terminals[0]?.title ?? tab.name;
const splitLabel = (terminal: TabTerminal, index: number) => terminal.title ?? `Terminal ${index + 1}`;

/** The host answers this window alone with terminal.opened. */
function requestTerminal(workspaceId: string, split: TerminalSplit | null) {
  const requestId = crypto.randomUUID();
  connection.send({ type: "terminal.open", requestId, workspaceId, split, columns: INITIAL_COLUMNS, rows: INITIAL_ROWS });
  return requestId;
}

function requestProgramTerminal(request: ProgramRequest) {
  const requestId = crypto.randomUUID();
  connection.send({ ...request, requestId, columns: INITIAL_COLUMNS, rows: INITIAL_ROWS });
  return requestId;
}

/**
 * The workspace's terminal tabs as the host lists them, the shell this window opened last, and the terminal ⌘W left
 * open because it runs a command. A pane that opens onto no tabs starts one; after the last shell exits, the user decides.
 */
function useWorkspaceTerminals(workspaceId: string, status: ConnectionStatus) {
  const [tabs, setTabs] = useState<TerminalTab[] | null>(null);
  const [opened, setOpened] = useState<{ tabId: string; terminalId: string } | null>(null);
  const [busy, setBusy] = useState<BusyClose | null>(null);
  const requests = useRef(new Set<string>());
  const open = (split: TerminalSplit | null) => requests.current.add(requestTerminal(workspaceId, split));
  const programRequest = useProgramRequest();

  useEffect(() => {
    if (status !== "open" || tabs === null || programRequest === null) return;
    const request = takeProgramRequest();
    if (request) requests.current.add(requestProgramTerminal(request));
  }, [status, tabs, programRequest]);

  useEffect(() => {
    if (status !== "open") return;
    let firstListing = true;
    const stopListening = connection.onMessage((message) => {
      if (message.type === "terminal.opened" && requests.current.delete(message.requestId)) setOpened({ tabId: message.tabId, terminalId: message.terminalId });
      if (message.type === "terminal.busy") setBusy({ terminalId: message.terminalId, command: message.command, tabId: message.tabId });
      if (message.type !== "terminals.listed" || message.workspaceId !== workspaceId) return;
      if (firstListing && message.tabs.length === 0) requests.current.add(requestTerminal(workspaceId, null));
      firstListing = false;
      setTabs(message.tabs);
    });
    connection.send({ type: "terminals.attach", workspaceId });
    return () => {
      stopListening();
      setTabs(null);
      connection.send({ type: "terminals.attach", workspaceId: null });
    };
  }, [workspaceId, status]);

  return { tabs, opened, open, busy };
}

function copySelection(view: Terminal) {
  if (view.hasSelection()) void navigator.clipboard.writeText(view.getSelection());
}

/**
 * Copy on select copies when the mouse is released after selecting, by dragging or double- or triple-clicking. The
 * browser lets a page write to the clipboard only while handling such an input, so not later, when the selection changes.
 */
function copySelectionWhenReleased(view: Terminal) {
  document.addEventListener("mouseup", () => copiesOnSelect() && copySelection(view), { once: true });
}

/** A split hidden behind a zoomed one has no size; fitting it then would shrink its shell to two columns. */
const isShown = (element: HTMLElement) => element.offsetWidth > 0 && element.offsetHeight > 0;

/**
 * Writes output the terminal already consumed. Answering the programs' questions in it — the cursor position, the
 * background colour — would send the answers back down the shell's input, where they land as typed text.
 */
function writeReplayedHistory(view: Terminal, data: string) {
  view.reset();
  view.options.disableStdin = true;
  view.write(data, () => {
    view.options.disableStdin = false;
  });
}

function TerminalView({ terminalId, focus, events }: { terminalId: string; focus: FocusRequest | undefined; events: RefObject<TerminalEvents> }) {
  const screen = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);

  useEffect(() => {
    const view = new Terminal({ fontFamily: TERMINAL_FONT, fontSize: terminalFontSize(), cursorBlink: true, scrollback: 5_000, theme: terminalTheme });
    const fit = new FitAddon();
    const fitIfShown = () => isShown(screen.current!) && fit.fit();
    const applyFontSize = () => {
      view.options.fontSize = terminalFontSize();
      fitIfShown();
    };
    view.loadAddon(fit);
    view.attachCustomKeyEventHandler((event) => {
      if (event.defaultPrevented) return false;
      const action = terminalKeyAction(event);
      if (!action) return true;
      if (action.type === "browser-paste") return false;
      if (event.type === "keydown") {
        event.preventDefault();
        if (action.type === "clear") connection.send({ type: "terminal.clear", terminalId });
        else if (action.type === "copy") copySelection(view);
        else if (action.type === "pane") events.current.command(action.command, terminalId);
        else view.input(action.data);
      }
      return false;
    });
    const screenElement = screen.current!;
    view.open(screenElement);
    const startSelecting = () => copySelectionWhenReleased(view);
    screenElement.addEventListener("mousedown", startSelecting);
    view.textarea?.setAttribute("writingsuggestions", "false");
    view.textarea?.addEventListener("focus", () => events.current.focused(terminalId));

    const stopListening = connection.onMessage((message) => {
      if (!("terminalId" in message) || message.terminalId !== terminalId) return;
      if (message.type === "terminal.replayed") writeReplayedHistory(view, message.data);
      else if (message.type === "terminal.output") view.write(message.data);
      else if (message.type === "terminal.cleared") view.write("", () => view.clear());
    });
    const typed = view.onData((data) => connection.send({ type: "terminal.input", terminalId, data }));
    const resized = view.onResize(({ cols, rows }) => connection.send({ type: "terminal.resize", terminalId, columns: cols, rows }));
    const observer = new ResizeObserver(fitIfShown);
    observer.observe(screen.current!);
    const stopFontListening = subscribeTerminalFontSize(applyFontSize);

    fitIfShown();
    connection.send({ type: "terminal.resize", terminalId, columns: view.cols, rows: view.rows });
    connection.send({ type: "terminal.replay", terminalId });
    terminal.current = view;
    return () => {
      terminal.current = null;
      screenElement.removeEventListener("mousedown", startSelecting);
      observer.disconnect();
      stopFontListening();
      typed.dispose();
      resized.dispose();
      stopListening();
      view.dispose();
    };
  }, [terminalId]);

  useEffect(() => {
    if (focus) terminal.current?.focus();
  }, [focus]);

  return (
    <div className="terminal-view">
      <div className="terminal-screen" ref={screen} />
    </div>
  );
}

/** Each split's part of its group, kept while the page is open so a tab looks the same when shown again. */
const splitShares = new Map<string, number>();
const shareOf = (layout: TerminalLayout) => splitShares.get(layoutKey(layout)) ?? 1;
const flexOf = (layout: TerminalLayout): CSSProperties => ({ flex: `${shareOf(layout)} 1 0` });

const placedTerminalsIn = (splits: HTMLElement | null): PlacedTerminal[] =>
  [...(splits?.querySelectorAll<HTMLElement>("[data-terminal-id]") ?? [])].map((split) => {
    const { left, top, right, bottom } = split.getBoundingClientRect();
    return { id: split.dataset.terminalId!, left, top, right, bottom };
  });

function TabLayout({
  tab,
  focus,
  zoomed,
  busy,
  events,
  splitsRef,
  onShowAll,
}: {
  tab: TerminalTab;
  focus: FocusRequest | null;
  zoomed: string | null;
  busy: BusyClose | null;
  events: RefObject<TerminalEvents>;
  splitsRef: RefObject<HTMLDivElement | null>;
  onShowAll: () => void;
}) {
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const resize = (before: TerminalLayout, after: TerminalLayout, beforeShare: number) => {
    const pair = shareOf(before) + shareOf(after);
    splitShares.set(layoutKey(before), pair * beforeShare);
    splitShares.set(layoutKey(after), pair * (1 - beforeShare));
    rerender();
  };
  const isSplit = tab.terminals.length > 1;
  const zoomedHere = zoomed !== null && tab.terminals.some(({ id }) => id === zoomed) ? zoomed : null;
  const zoomedAway = (layout: TerminalLayout) => (zoomedHere !== null && !terminalsIn(layout).includes(zoomedHere) ? " zoomed-away" : "");

  const split = (terminalId: string, style: CSSProperties) => {
    const index = tab.terminals.findIndex(({ id }) => id === terminalId);
    const asksAgain = busy?.terminalId === terminalId && busy.tabId === undefined;
    return (
      <div className={`terminal-split${zoomedAway({ terminalId })}`} data-terminal-id={terminalId} style={style}>
        {isSplit && (
          <div className="split-strip">
            <span className="split-title">{splitLabel(tab.terminals[index]!, index)}</span>
            {zoomedHere === terminalId && (
              <button type="button" className="link show-all-splits" data-hint={hints.terminalShowAll} data-shortcut={terminalShortcutKeys()?.zoom} onClick={onShowAll}>
                Show all
              </button>
            )}
            <ConfirmButton
              className="icon close-split"
              label={`Close terminal ${index + 1}`}
              hint={hints.terminalCloseSplit}
              armedText="Close?"
              armedHint={asksAgain ? hints.terminalCloseBusy(busy.command) : hints.terminalCloseSplitArmed}
              armRequest={asksAgain ? busy : null}
              onConfirm={() => connection.send({ type: "terminal.close", terminalId })}
            >
              ×
            </ConfirmButton>
          </div>
        )}
        <TerminalView terminalId={terminalId} focus={focus?.terminalId === terminalId ? focus : undefined} events={events} />
      </div>
    );
  };

  const node = (layout: TerminalLayout, style: CSSProperties): ReactNode => {
    if (isTerminal(layout)) return split(layout.terminalId, style);
    return (
      <div className={`terminal-group ${layout.axis}${zoomedAway(layout)}`} style={style}>
        {layout.children.map((child, index) => {
          const previous = layout.children[index - 1];
          return (
            <Fragment key={layoutKey(child)}>
              {previous && zoomedHere === null && (
                <Splitter
                  axis={layout.axis}
                  share={shareOf(previous) / (shareOf(previous) + shareOf(child))}
                  onChange={(share) => resize(previous, child, share)}
                  label="Resize terminals"
                  resetShare={0.5}
                  minimumSize={MIN_SPLIT_SIZE[layout.axis]}
                />
              )}
              {node(child, flexOf(child))}
            </Fragment>
          );
        })}
      </div>
    );
  };

  return (
    <div className="terminal-splits" ref={splitsRef}>
      {node(tab.layout, { flex: "1 1 0" })}
    </div>
  );
}

/** The tab each workspace showed last, kept while the page is open. */
const lastActiveTabs = new Map<string, string>();

export function TerminalPane({ workspace, status, onHide }: { workspace: Workspace; status: ConnectionStatus; onHide: () => void }) {
  const { tabs, opened, open, busy } = useWorkspaceTerminals(workspace.id, status);
  const [activeTabId, setActiveTabId] = useState(() => lastActiveTabs.get(workspace.id) ?? null);
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  const [zoomed, setZoomed] = useState<string | null>(null);
  const [armedTabClose, setArmedTabClose] = useState<string | null>(null);
  /** The terminal each tab had the keyboard focus in last, which the buttons and a tab shown again go to. */
  const focusedIn = useRef(new Map<string, string>());
  /** Where the focus goes once the terminal ⌘W closes is gone: the split before it, or after it. */
  const focusAfterClose = useRef<string | null>(null);
  const splits = useRef<HTMLDivElement>(null);
  const activeTab = tabs?.find(({ id }) => id === activeTabId) ?? tabs?.[0];
  const terminalIds = activeTab?.terminals.map(({ id }) => id) ?? [];
  const keys = terminalShortcutKeys();

  const lastFocusedIn = (tab: TerminalTab) => {
    const remembered = [focusAfterClose.current, focusedIn.current.get(tab.id)];
    return remembered.find((terminalId) => tab.terminals.some(({ id }) => id === terminalId)) ?? tab.terminals[0]!.id;
  };

  useEffect(() => {
    if (activeTab) lastActiveTabs.set(workspace.id, activeTab.id);
  }, [workspace.id, activeTab?.id]);

  useEffect(() => {
    if (activeTab && !terminalIds.includes(focus?.terminalId ?? "")) setFocus({ terminalId: lastFocusedIn(activeTab) });
  }, [focus, activeTab]);

  useEffect(() => {
    if (!opened) return;
    setActiveTabId(opened.tabId);
    setFocus({ terminalId: opened.terminalId });
  }, [opened]);

  const show = (tab: TerminalTab) => {
    setActiveTabId(tab.id);
    setFocus({ terminalId: lastFocusedIn(tab) });
  };

  const focusTerminal = (terminalId: string | null) => {
    if (!terminalId) return;
    setZoomed(null);
    setFocus({ terminalId });
  };

  const split = (terminalId: string, axis: TerminalSplit["axis"]) => {
    if (terminalIds.length >= MAX_TERMINALS_PER_TAB) return;
    setZoomed(null);
    open({ terminalId, axis });
  };

  const closeUnlessBusy = (terminalId: string) => {
    const index = terminalIds.indexOf(terminalId);
    focusAfterClose.current = terminalIds[index - 1] ?? terminalIds[index + 1] ?? null;
    connection.send({ type: "terminal.close", terminalId, unlessBusy: true });
  };

  const closeTabOnMiddleClick = (tab: TerminalTab) => (event: MouseEvent) => {
    if (!isMiddleButton(event)) return;
    event.preventDefault();
    connection.send({ type: "terminal.close-tab", tabId: tab.id, unlessBusy: armedTabClose !== tab.id });
  };

  const showTabAt = (index: number) => {
    const tab = tabs?.[index];
    if (tab) show(tab);
  };

  const run = (command: PaneCommand, terminalId: string) => {
    if (!activeTab || !tabs) return;
    const tabIndex = tabs.indexOf(activeTab);
    switch (command.type) {
      case "split":
        return split(terminalId, command.axis);
      case "new-tab":
        return open(null);
      case "close":
        return closeUnlessBusy(terminalId);
      case "focus-toward":
        return focusTerminal(terminalToward(placedTerminalsIn(splits.current), terminalId, command.direction));
      case "focus-step":
        return focusTerminal(terminalAfter(terminalIds, terminalId, command.step));
      case "tab-step":
        return showTabAt((tabIndex + command.step + tabs.length) % tabs.length);
      case "tab-number":
        return showTabAt(command.number - 1);
      case "zoom":
        return setZoomed(zoomed === terminalId || terminalIds.length < 2 ? null : terminalId);
    }
  };

  const events = useRef<TerminalEvents>(null!);
  events.current = {
    command: run,
    focused: (terminalId) => {
      if (activeTab) focusedIn.current.set(activeTab.id, terminalId);
      focusAfterClose.current = null;
    },
  };

  const focused = activeTab && lastFocusedIn(activeTab);
  const canSplit = focused !== undefined && terminalIds.length < MAX_TERMINALS_PER_TAB;

  return (
    <section className="terminal-pane" aria-label={`Terminals in ${workspace.name}`}>
      <header className="terminal-bar" data-pane-bar>
        <PaneGrip pane="terminals" />
        <div className="terminal-tabs" role="tablist" aria-label="Terminal tabs">
          {tabs?.map((tab) => {
            const asksAgain = tabCloseAsksAgain(tab, busy);
            return (
              <div key={tab.id} className={`terminal-tab ${tab.id === activeTab?.id ? "active" : ""}`} onMouseDown={closeTabOnMiddleClick(tab)}>
                <button type="button" role="tab" aria-selected={tab.id === activeTab?.id} data-hint={tabLabel(tab)} onClick={() => show(tab)}>
                  {tabLabel(tab)}
                </button>
                <ConfirmButton
                  className="icon close-tab"
                  label={`Close ${tabLabel(tab)}`}
                  hint={hints.terminalCloseTab}
                  armedText="Close?"
                  armedHint={asksAgain ? (busy.tabId ? hints.terminalCloseTabBusy(busy.command) : hints.terminalCloseBusy(busy.command)) : hints.terminalCloseTabArmed}
                  armRequest={asksAgain ? busy : null}
                  onArmedChange={(armed) => setArmedTabClose((current) => (armed ? tab.id : current === tab.id ? null : current))}
                  onConfirm={() => connection.send({ type: "terminal.close-tab", tabId: tab.id })}
                >
                  ×
                </ConfirmButton>
              </div>
            );
          })}
          {tabs && (
            <button type="button" className="icon new-tab" aria-label="New terminal tab" data-hint={hints.terminalNewTab} data-shortcut={keys?.newTab} onClick={() => open(null)}>
              +
            </button>
          )}
        </div>
        <button
          type="button"
          className="icon split-terminal"
          aria-label="Split right"
          data-hint={hints.terminalSplit}
          data-shortcut={keys?.splitRight}
          disabled={!canSplit}
          onClick={() => focused && split(focused, "columns")}
        >
          ◫
        </button>
        <button
          type="button"
          className="icon split-terminal"
          aria-label="Split down"
          data-hint={hints.terminalSplitDown}
          data-shortcut={keys?.splitDown}
          disabled={!canSplit}
          onClick={() => focused && split(focused, "rows")}
        >
          ⊟
        </button>
        <FullscreenToggle pane="terminals" />
        <button type="button" className="link" data-hint={hints.terminalHide} onClick={onHide}>
          Hide
        </button>
      </header>
      {activeTab ? (
        <TabLayout key={activeTab.id} tab={activeTab} focus={focus} zoomed={zoomed} busy={busy} events={events} splitsRef={splits} onShowAll={() => setZoomed(null)} />
      ) : (
        <div className="terminal-view terminal-start">
          {tabs && (
            <button type="button" onClick={() => open(null)}>
              Start a shell
            </button>
          )}
        </div>
      )}
    </section>
  );
}
