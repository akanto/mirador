import type { CodeSpan } from "./highlight.ts";

export function CodeText({ text, spans }: { text: string; spans: CodeSpan[] | undefined }) {
  if (!spans) return <code className="code-text">{text || " "}</code>;
  return (
    <code className="code-text">
      {spans.length === 0 ? " " : spans.map(({ text: piece, type }, index) => (type ? <span key={index} className={`token ${type}`}>{piece}</span> : piece))}
    </code>
  );
}
