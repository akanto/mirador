import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Fragment, useEffect, useReducer, useRef, useState } from "react";
import { MAX_TERMINALS_PER_TAB, type TabTerminal, type TerminalTab, type Workspace } from "../shared/model.ts";
import { ConfirmButton } from "./ConfirmButton.tsx";
import { connection, type ConnectionStatus } from "./connection.ts";
import { hints } from "./hints.ts";
import { Splitter } from "./Splitter.tsx";
import { TERMINAL_FONT, terminalTheme } from "./terminal-look.ts";

const INITIAL_COLUMNS = 80;
const INITIAL_ROWS = 24;
const MIN_SPLIT_WIDTH = 120;

interface FocusRequest {
  terminalId: string;
}

const tabLabel = (tab: TerminalTab) => tab.terminals[0]?.title ?? tab.name;
const splitLabel = (terminal: TabTerminal, index: number) => terminal.title ?? `Terminal ${index + 1}`;

/** The host answers this window alone with terminal.opened. */
function requestTerminal(workspaceId: string, tabId: string | null) {
  const requestId = crypto.randomUUID();
  connection.send({ type: "terminal.open", requestId, workspaceId, tabId, columns: INITIAL_COLUMNS, rows: INITIAL_ROWS });
  return requestId;
}

/**
 * The workspace's terminal tabs as the host lists them, and the shell this window opened last.
 * A pane that opens onto no tabs starts one; after the last shell exits, the user decides.
 */
function useWorkspaceTerminals(workspaceId: string, status: ConnectionStatus) {
  const [tabs, setTabs] = useState<TerminalTab[] | null>(null);
  const [opened, setOpened] = useState<{ tabId: string; terminalId: string } | null>(null);
  const requests = useRef(new Set<string>());
  const open = (tabId: string | null) => requests.current.add(requestTerminal(workspaceId, tabId));

  useEffect(() => {
    if (status !== "open") return;
    let firstListing = true;
    const stopListening = connection.onMessage((message) => {
      if (message.type === "terminal.opened" && requests.current.delete(message.requestId)) setOpened({ tabId: message.tabId, terminalId: message.terminalId });
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

  return { tabs, opened, open };
}

function TerminalView({ terminalId, focus }: { terminalId: string; focus: FocusRequest | undefined }) {
  const screen = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);

  useEffect(() => {
    const view = new Terminal({ fontFamily: TERMINAL_FONT, fontSize: 12, cursorBlink: true, scrollback: 5_000, theme: terminalTheme });
    const fit = new FitAddon();
    view.loadAddon(fit);
    view.attachCustomKeyEventHandler((event) => !event.defaultPrevented);
    view.open(screen.current!);

    const stopListening = connection.onMessage((message) => {
      if (!("terminalId" in message) || message.terminalId !== terminalId) return;
      if (message.type === "terminal.replayed") {
        view.reset();
        view.write(message.data);
      } else if (message.type === "terminal.output") view.write(message.data);
    });
    const typed = view.onData((data) => connection.send({ type: "terminal.input", terminalId, data }));
    const resized = view.onResize(({ cols, rows }) => connection.send({ type: "terminal.resize", terminalId, columns: cols, rows }));
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(screen.current!);

    fit.fit();
    connection.send({ type: "terminal.resize", terminalId, columns: view.cols, rows: view.rows });
    connection.send({ type: "terminal.replay", terminalId });
    terminal.current = view;
    return () => {
      terminal.current = null;
      observer.disconnect();
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

/** Each split's part of its tab's width, kept while the page is open so a tab looks the same when shown again. */
const splitShares = new Map<string, number>();
const shareOf = (terminalId: string) => splitShares.get(terminalId) ?? 1;

function TabSplits({ tab, focus }: { tab: TerminalTab; focus: FocusRequest | null }) {
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const resize = (left: string, right: string, leftShare: number) => {
    const pair = shareOf(left) + shareOf(right);
    splitShares.set(left, pair * leftShare);
    splitShares.set(right, pair * (1 - leftShare));
    rerender();
  };
  const isSplit = tab.terminals.length > 1;

  return (
    <div className="terminal-splits">
      {tab.terminals.map((terminal, index) => {
        const previous = tab.terminals[index - 1]?.id;
        return (
          <Fragment key={terminal.id}>
            {previous && (
              <Splitter
                share={shareOf(previous) / (shareOf(previous) + shareOf(terminal.id))}
                onChange={(share) => resize(previous, terminal.id, share)}
                label="Resize terminals"
                resetShare={0.5}
                minimumWidth={MIN_SPLIT_WIDTH}
              />
            )}
            <div className="terminal-split" style={{ flex: `${shareOf(terminal.id)} 1 0` }}>
              {isSplit && (
                <div className="split-strip">
                  <span className="split-title">{splitLabel(terminal, index)}</span>
                  <ConfirmButton
                    className="icon close-split"
                    label={`Close terminal ${index + 1}`}
                    hint={hints.terminalCloseSplit}
                    armedText="Close?"
                    armedHint={hints.terminalCloseSplitArmed}
                    onConfirm={() => connection.send({ type: "terminal.close", terminalId: terminal.id })}
                  >
                    ×
                  </ConfirmButton>
                </div>
              )}
              <TerminalView terminalId={terminal.id} focus={focus?.terminalId === terminal.id ? focus : undefined} />
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}

/** The tab each workspace showed last, kept while the page is open. */
const lastActiveTabs = new Map<string, string>();

export function TerminalPane({ workspace, status, onHide }: { workspace: Workspace; status: ConnectionStatus; onHide: () => void }) {
  const { tabs, opened, open } = useWorkspaceTerminals(workspace.id, status);
  const [activeTabId, setActiveTabId] = useState(() => lastActiveTabs.get(workspace.id) ?? null);
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  const activeTab = tabs?.find(({ id }) => id === activeTabId) ?? tabs?.[0];

  useEffect(() => {
    if (activeTab) lastActiveTabs.set(workspace.id, activeTab.id);
  }, [workspace.id, activeTab?.id]);

  useEffect(() => {
    if (focus === null && activeTab) setFocus({ terminalId: activeTab.terminals[0]!.id });
  }, [focus, activeTab]);

  useEffect(() => {
    if (!opened) return;
    setActiveTabId(opened.tabId);
    setFocus({ terminalId: opened.terminalId });
  }, [opened]);

  const show = (tab: TerminalTab) => {
    setActiveTabId(tab.id);
    setFocus({ terminalId: tab.terminals[0]!.id });
  };

  return (
    <section className="terminal-pane" aria-label={`Terminals in ${workspace.name}`}>
      <header className="terminal-bar">
        <div className="terminal-tabs" role="tablist" aria-label="Terminal tabs">
          {tabs?.map((tab) => (
            <div key={tab.id} className={`terminal-tab ${tab.id === activeTab?.id ? "active" : ""}`}>
              <button type="button" role="tab" aria-selected={tab.id === activeTab?.id} data-hint={tabLabel(tab)} onClick={() => show(tab)}>
                {tabLabel(tab)}
              </button>
              <ConfirmButton
                className="icon close-tab"
                label={`Close ${tabLabel(tab)}`}
                hint={hints.terminalCloseTab}
                armedText="Close?"
                armedHint={hints.terminalCloseTabArmed}
                onConfirm={() => connection.send({ type: "terminal.close-tab", tabId: tab.id })}
              >
                ×
              </ConfirmButton>
            </div>
          ))}
          {tabs && (
            <button type="button" className="icon new-tab" aria-label="New terminal tab" data-hint={hints.terminalNewTab} onClick={() => open(null)}>
              +
            </button>
          )}
        </div>
        <button
          type="button"
          className="icon split-terminal"
          aria-label="Split terminal"
          data-hint={hints.terminalSplit}
          disabled={!activeTab || activeTab.terminals.length >= MAX_TERMINALS_PER_TAB}
          onClick={() => activeTab && open(activeTab.id)}
        >
          ◫
        </button>
        <button type="button" className="link" data-hint={hints.terminalHide} onClick={onHide}>
          Hide
        </button>
      </header>
      {activeTab ? (
        <TabSplits key={activeTab.id} tab={activeTab} focus={focus} />
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
