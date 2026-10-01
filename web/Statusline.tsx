import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState, type RefObject } from "react";
import { chosenModel } from "../shared/config-options.ts";
import type { ContextUsage, Conversation, Profile, StatuslineRender } from "../shared/model.ts";
import { connection } from "./connection.ts";
import { hints } from "./hints.ts";
import { compactTokenCount, contextHint, contextLevel, formatCost, usedPercentLabel, usedShare } from "./usage.ts";

/** Statusline scripts draw with Nerd Font glyphs; the first of these the Mac has renders them. */
const TERMINAL_FONT = '"MesloLGS NF", "Symbols Nerd Font Mono", "JetBrainsMono Nerd Font", "Hack Nerd Font", Menlo, monospace';
const TERMINAL_FONT_SIZE = 12;
const REQUEST_DELAY_MS = 300;
const REFRESH_MS = 30_000;
const MAX_WRAPPED_ROWS = 12;
const PREFERENCE_KEY = "mirador-statusline";
const ansiEscape = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g;

export function ContextMeter({ usage }: { usage: ContextUsage }) {
  const share = usedShare(usage);
  return (
    <span className={`context-meter level-${contextLevel(share)}`} data-hint={contextHint(usage)} aria-label={`Context ${usedPercentLabel(usage)} used`}>
      <span className="context-bar" aria-hidden="true">
        <span style={{ width: `${share * 100}%` }} />
      </span>
      {usedPercentLabel(usage)} · {compactTokenCount(usage.used)} / {compactTokenCount(usage.size)}
    </span>
  );
}

function usePrefersCommand() {
  const [prefersCommand, setPrefersCommand] = useState(() => {
    try {
      return localStorage.getItem(PREFERENCE_KEY) !== "built-in";
    } catch {
      return true;
    }
  });
  const choose = (next: boolean) => {
    setPrefersCommand(next);
    try {
      localStorage.setItem(PREFERENCE_KEY, next ? "command" : "built-in");
    } catch {}
  };
  return [prefersCommand, choose] as const;
}

function terminalCellWidth() {
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return 7.2;
  context.font = `${TERMINAL_FONT_SIZE}px ${TERMINAL_FONT}`;
  return context.measureText("M".repeat(100)).width / 100;
}

/** How many terminal columns fit the element, one short so that rounding in the terminal never wraps the last glyph. */
function useColumns(element: RefObject<HTMLElement | null>) {
  const [columns, setColumns] = useState<number | null>(null);
  useEffect(() => {
    const target = element.current;
    if (!target) return;
    const cellWidth = terminalCellWidth();
    const observer = new ResizeObserver(() => setColumns(Math.max(1, Math.floor(target.clientWidth / cellWidth) - 1)));
    observer.observe(target);
    return () => observer.disconnect();
  }, []);
  return columns;
}

/** Asks the host again whenever the conversation changes, and now and then for clocks and quotas the command may show. */
function useStatuslineRender(conversation: Conversation, columns: number | null, runCommand: boolean) {
  const [render, setRender] = useState<StatuslineRender | null>(null);
  useEffect(() => setRender(null), [conversation.id]);
  useEffect(() => {
    if (!columns) return;
    let latestRequest: string | null = null;
    const request = () => {
      latestRequest = crypto.randomUUID();
      connection.send({ type: "statusline.render", requestId: latestRequest, conversationId: conversation.id, columns, runCommand });
    };
    const stopListening = connection.onMessage((message) => {
      if (message.type === "statusline.rendered" && message.requestId === latestRequest) setRender(message.statusline);
    });
    const delayed = setTimeout(request, REQUEST_DELAY_MS);
    const refresh = setInterval(request, REFRESH_MS);
    return () => {
      clearTimeout(delayed);
      clearInterval(refresh);
      stopListening();
    };
  }, [conversation, columns, runCommand]);
  return render;
}

/** Lines wider than the pane wrap onto rows of their own; growing the terminal brings back the rows they pushed out of view. */
function growToShowWrappedLines(terminal: Terminal, columns: number) {
  const renderedRows = Math.min(MAX_WRAPPED_ROWS, terminal.buffer.active.length);
  if (renderedRows > terminal.rows) terminal.resize(columns, renderedRows);
}

function TerminalText({ text, columns }: { text: string; columns: number }) {
  const container = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);

  useEffect(() => {
    const created = new Terminal({
      disableStdin: true,
      convertEol: true,
      cursorInactiveStyle: "none",
      allowTransparency: true,
      fontFamily: TERMINAL_FONT,
      fontSize: TERMINAL_FONT_SIZE,
      scrollback: MAX_WRAPPED_ROWS,
      cols: columns,
      rows: 1,
    });
    created.open(container.current!);
    created.textarea?.setAttribute("tabindex", "-1");
    terminal.current = created;
    return () => {
      created.dispose();
      terminal.current = null;
    };
  }, []);

  useEffect(() => {
    const current = terminal.current;
    if (!current) return;
    current.options.theme = { background: "rgba(0, 0, 0, 0)", foreground: getComputedStyle(container.current!).color };
    current.reset();
    current.resize(columns, text.split("\n").length);
    current.write(`\x1b[?25l${text}`, () => growToShowWrappedLines(current, columns));
  }, [text, columns]);

  return <div ref={container} className="statusline-terminal" role="img" aria-label={text.replace(ansiEscape, "").trim()} />;
}

function BuiltInStatusline({ conversation, profiles, gitBranch }: { conversation: Conversation; profiles: Profile[]; gitBranch: string | null }) {
  const model = chosenModel(conversation.configOptions);
  const profile = profiles.find(({ id }) => id === conversation.profileId);
  const usage = conversation.contextUsage;
  return (
    <div className="statusline-chips">
      {gitBranch && (
        <span className="chip" data-hint={hints.gitBranch}>
          ⎇ {gitBranch}
        </span>
      )}
      {model && (
        <span className="chip" data-hint={hints.model}>
          {model.name}
        </span>
      )}
      {usage && <ContextMeter usage={usage} />}
      {usage?.cost && (
        <span className="chip" data-hint={hints.cost}>
          {formatCost(usage.cost)}
        </span>
      )}
      {profile && (
        <span className="chip" data-hint={hints.profileChip}>
          {profile.name}
        </span>
      )}
    </div>
  );
}

export function Statusline({ conversation, profiles }: { conversation: Conversation; profiles: Profile[] }) {
  const [prefersCommand, setPrefersCommand] = usePrefersCommand();
  const content = useRef<HTMLDivElement>(null);
  const columns = useColumns(content);
  const render = useStatuslineRender(conversation, columns, prefersCommand);
  const commandOutput = prefersCommand ? (render?.output ?? null) : null;

  return (
    <section className="statusline" aria-label="Statusline">
      <div className="statusline-content" ref={content}>
        {commandOutput !== null && columns ? (
          <TerminalText text={commandOutput} columns={columns} />
        ) : (
          <BuiltInStatusline conversation={conversation} profiles={profiles} gitBranch={render?.gitBranch ?? null} />
        )}
      </div>
      {prefersCommand && render?.error && (
        <span className="statusline-error" role="img" aria-label="Statusline command failed" data-hint={render.error}>
          ⚠
        </span>
      )}
      {render?.command && (
        <button
          type="button"
          className="link statusline-source"
          data-hint={prefersCommand ? hints.statuslineCommand(render.command) : hints.statuslineBuiltIn(render.command)}
          onClick={() => setPrefersCommand(!prefersCommand)}
        >
          {prefersCommand ? "Built-in" : "Your statusline"}
        </button>
      )}
    </section>
  );
}
