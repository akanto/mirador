import { useEffect, useMemo, useRef, useState } from "react";
import { buildCanvasDocument, isCanvasFrameMessage } from "../shared/canvas-document.ts";
import type { AskOption, CanvasItem } from "../shared/model.ts";
import { connection } from "./connection.ts";

function CanvasFrame({
  frameId,
  html,
  assetsOrigin,
  className,
  fitsContent = false,
  onRendered,
}: {
  frameId: string;
  html: string;
  assetsOrigin: string;
  className?: string;
  fitsContent?: boolean;
  onRendered?: (errors: string[]) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [contentHeight, setContentHeight] = useState<number>();
  const document = useMemo(() => buildCanvasDocument(html, frameId, assetsOrigin), [html, frameId, assetsOrigin]);
  const onRenderedRef = useRef(onRendered);
  onRenderedRef.current = onRendered;

  useEffect(() => {
    setErrors([]);
    setContentHeight(undefined);
    const listener = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || !isCanvasFrameMessage(event.data)) return;
      const message = event.data;
      if (message.kind === "error") setErrors((current) => [...current, message.message]);
      if (message.kind === "rendered") onRenderedRef.current?.(message.errors);
      if (message.kind === "size") setContentHeight(message.height);
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [document]);

  return (
    <div className={`canvas-frame ${className ?? ""}`}>
      <iframe
        ref={frame}
        sandbox="allow-scripts"
        srcDoc={document}
        title={frameId}
        style={fitsContent && contentHeight ? { height: contentHeight } : undefined}
      />
      {errors.length > 0 && (
        <ul className="frame-errors">
          {errors.map((error, index) => (
            <li key={index}>{error}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function reportRender(itemId: string) {
  return (errors: string[]) => connection.send({ type: "canvas.report", itemId, errors });
}

function AskView({ item, assetsOrigin }: { item: CanvasItem; assetsOrigin: string }) {
  const [note, setNote] = useState("");
  const [other, setOther] = useState("");
  const waiting = item.status === "waiting";
  const choose = (label: string) => connection.send({ type: "ask.answer", itemId: item.id, label, note: note || undefined });
  const options: AskOption[] = item.options ?? [];

  return (
    <div className="ask">
      <h3>{item.question}</h3>
      {item.status === "answered" && item.answer && (
        <div className="ask-answer">
          You chose <strong>{item.answer.label}</strong>
          {item.answer.note && <> — “{item.answer.note}”</>}
          <span className="delivered">
            {item.answer.deliveredAs === "tool-result" ? " (returned to the agent)" : " (sent as your next message)"}
          </span>
        </div>
      )}
      {item.status === "cancelled" && <div className="ask-answer">This question was withdrawn.</div>}
      {item.html && <CanvasFrame frameId={`${item.id}-context`} html={item.html} assetsOrigin={assetsOrigin} className="ask-context" fitsContent />}
      <div className="ask-options">
        {options.map((option, index) => (
          <div key={option.label} className={`ask-option ${item.answer?.label === option.label ? "chosen" : ""}`}>
            <div className="ask-option-label">{option.label}</div>
            {option.description && <div className="ask-option-description">{option.description}</div>}
            {option.html && (
              <CanvasFrame frameId={`${item.id}-option-${index}`} html={option.html} assetsOrigin={assetsOrigin} className="ask-preview" fitsContent />
            )}
            {waiting && (
              <button className="choose" onClick={() => choose(option.label)}>
                Choose “{option.label}”
              </button>
            )}
          </div>
        ))}
      </div>
      {waiting && (
        <div className="ask-extras">
          {item.allowOther && (
            <div className="ask-other">
              <input value={other} placeholder="Something else…" onChange={(event) => setOther(event.target.value)} />
              <button disabled={!other.trim()} onClick={() => choose(other.trim())}>
                Send
              </button>
            </div>
          )}
          <textarea value={note} placeholder="Optional note for the agent (sent with your choice)" onChange={(event) => setNote(event.target.value)} />
        </div>
      )}
    </div>
  );
}

const statusLabels: Record<CanvasItem["status"], string> = {
  shown: "",
  waiting: "needs your answer",
  answered: "answered",
  cancelled: "withdrawn",
};

export function CanvasPanel({ items, assetsOrigin }: { items: CanvasItem[]; assetsOrigin: string }) {
  const newestFirst = useMemo(() => [...items].sort((a, b) => b.createdAt - a.createdAt), [items]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const newestId = newestFirst[0]?.id ?? null;
  useEffect(() => setSelectedId(newestId), [newestId]);
  const selected = newestFirst.find(({ id }) => id === selectedId) ?? newestFirst[0];

  return (
    <aside className="canvas-panel">
      <div className="canvas-tabs">
        {newestFirst.length === 0 && <span className="canvas-empty-tab">Canvas</span>}
        {newestFirst.map((item) => (
          <button key={item.id} className={`canvas-tab ${item.id === selected?.id ? "active" : ""} tab-${item.status}`} onClick={() => setSelectedId(item.id)}>
            <span className="tab-kind">{item.kind === "ask" ? "?" : "▣"}</span>
            <span className="tab-title">{item.title}</span>
            {statusLabels[item.status] && <span className="tab-status">{statusLabels[item.status]}</span>}
          </button>
        ))}
      </div>
      <div className="canvas-body">
        {!selected && <div className="empty">When the agent shows something or asks you to choose, it appears here.</div>}
        {selected?.kind === "show" && (
          <CanvasFrame
            key={selected.id}
            frameId={selected.id}
            html={selected.html ?? ""}
            assetsOrigin={assetsOrigin}
            className="show"
            onRendered={reportRender(selected.id)}
          />
        )}
        {selected?.kind === "ask" && <AskView key={selected.id} item={selected} assetsOrigin={assetsOrigin} />}
      </div>
    </aside>
  );
}
