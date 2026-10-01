import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import type { Workspace } from "../shared/model.ts";
import { connection, type ConnectionStatus } from "./connection.ts";
import { hints } from "./hints.ts";
import { TERMINAL_FONT, terminalTheme } from "./terminal-look.ts";

const INITIAL_COLUMNS = 80;
const INITIAL_ROWS = 24;

const openTerminal = (workspaceId: string) =>
  connection.send({ type: "terminal.open", workspaceId, columns: INITIAL_COLUMNS, rows: INITIAL_ROWS });

/** The workspace's shells as the host lists them. A pane that opens onto none starts one; after a shell exits, the user decides. */
function useWorkspaceTerminals(workspaceId: string, status: ConnectionStatus) {
  const [terminalIds, setTerminalIds] = useState<string[] | null>(null);
  useEffect(() => {
    if (status !== "open") return;
    let firstListing = true;
    const stopListening = connection.onMessage((message) => {
      if (message.type !== "terminals.listed" || message.workspaceId !== workspaceId) return;
      if (firstListing && message.terminalIds.length === 0) openTerminal(workspaceId);
      firstListing = false;
      setTerminalIds(message.terminalIds);
    });
    connection.send({ type: "terminals.attach", workspaceId });
    return () => {
      stopListening();
      setTerminalIds(null);
      connection.send({ type: "terminals.attach", workspaceId: null });
    };
  }, [workspaceId, status]);
  return terminalIds;
}

function TerminalView({ terminalId }: { terminalId: string }) {
  const screen = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const terminal = new Terminal({ fontFamily: TERMINAL_FONT, fontSize: 12, cursorBlink: true, scrollback: 5_000, theme: terminalTheme });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.attachCustomKeyEventHandler((event) => !event.defaultPrevented);
    terminal.open(screen.current!);

    const stopListening = connection.onMessage((message) => {
      if (!("terminalId" in message) || message.terminalId !== terminalId) return;
      if (message.type === "terminal.replayed") {
        terminal.reset();
        terminal.write(message.data);
      } else if (message.type === "terminal.output") terminal.write(message.data);
    });
    const typed = terminal.onData((data) => connection.send({ type: "terminal.input", terminalId, data }));
    const resized = terminal.onResize(({ cols, rows }) => connection.send({ type: "terminal.resize", terminalId, columns: cols, rows }));
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(screen.current!);

    fit.fit();
    connection.send({ type: "terminal.resize", terminalId, columns: terminal.cols, rows: terminal.rows });
    connection.send({ type: "terminal.replay", terminalId });
    terminal.focus();
    return () => {
      observer.disconnect();
      typed.dispose();
      resized.dispose();
      stopListening();
      terminal.dispose();
    };
  }, [terminalId]);

  return (
    <div className="terminal-view">
      <div className="terminal-screen" ref={screen} />
    </div>
  );
}

export function TerminalPane({ workspace, status, onHide }: { workspace: Workspace; status: ConnectionStatus; onHide: () => void }) {
  const terminalIds = useWorkspaceTerminals(workspace.id, status);
  const terminalId = terminalIds?.[0];
  return (
    <section className="terminal-pane" aria-label="Terminal">
      <header className="terminal-bar">
        <span className="terminal-title" title={workspace.path}>
          Terminal · {workspace.name}
        </span>
        <button type="button" className="link" data-hint={hints.terminalHide} onClick={onHide}>
          Hide
        </button>
      </header>
      {terminalId ? (
        <TerminalView key={terminalId} terminalId={terminalId} />
      ) : (
        <div className="terminal-view terminal-idle">
          {terminalIds && (
            <button type="button" onClick={() => openTerminal(workspace.id)}>
              Start a shell
            </button>
          )}
        </div>
      )}
    </section>
  );
}
