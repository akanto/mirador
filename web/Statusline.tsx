import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { chosenModel } from "../shared/config-options.ts";
import type { ContextUsage, Conversation, Profile, StatuslineRender } from "../shared/model.ts";
import { parseAnsi, plainTextOf, type AnsiStyle } from "./ansi.ts";
import { connection } from "./connection.ts";
import { hints } from "./hints.ts";
import { compactTokenCount, contextHint, contextLevel, formatCost, usedPercentLabel, usedShare } from "./usage.ts";

/** Statusline scripts draw with Nerd Font glyphs; the first of these the Mac has renders them. */
const TERMINAL_FONT = '"MesloLGS NF", "Symbols Nerd Font Mono", "JetBrainsMono Nerd Font", "Hack Nerd Font", Menlo, monospace';
const TERMINAL_FONT_SIZE = 12;
const TERMINAL_PADDING_X = 8;
const REQUEST_DELAY_MS = 300;
const REFRESH_MS = 30_000;
const PREFERENCE_KEY = "mirador-statusline";

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
    const observer = new ResizeObserver(() => setColumns(Math.max(1, Math.floor((target.clientWidth - 2 * TERMINAL_PADDING_X) / cellWidth) - 1)));
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

function cssOf({ foreground, background, bold, dim, italic, underline, inverse, strikethrough }: AnsiStyle): CSSProperties {
  const [color, backgroundColor] = inverse
    ? [background ?? "var(--terminal-background)", foreground ?? "var(--terminal-foreground)"]
    : [foreground, background];
  return {
    color: dim ? `color-mix(in srgb, ${color ?? "var(--terminal-foreground)"} 60%, transparent)` : color,
    backgroundColor,
    fontWeight: bold ? 700 : undefined,
    fontStyle: italic ? "italic" : undefined,
    textDecoration: [underline && "underline", strikethrough && "line-through"].filter(Boolean).join(" ") || undefined,
  };
}

/** The command's output drawn as a terminal would, on a terminal's dark background, since statusline scripts colour themselves for one. */
function TerminalText({ text }: { text: string }) {
  const lines = useMemo(() => parseAnsi(text), [text]);
  return (
    <div
      className="statusline-terminal"
      role="img"
      aria-label={plainTextOf(lines).trim()}
      style={{ fontFamily: TERMINAL_FONT, fontSize: TERMINAL_FONT_SIZE, paddingInline: TERMINAL_PADDING_X }}
    >
      {lines.map((runs, lineIndex) => (
        <div key={lineIndex} className="statusline-line">
          {runs.map((run, runIndex) => (
            <span key={runIndex} style={cssOf(run.style)}>
              {run.text}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
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
          <TerminalText text={commandOutput} />
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
