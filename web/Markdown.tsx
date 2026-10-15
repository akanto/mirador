import { memo, useEffect, useRef, useState, type ComponentProps } from "react";
import Markdown, { type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";

const COPY_OUTCOME_SHOWN_MS = 1_500;

/** The block's text as written: markdown ends a code block's last line with a line break the author did not write. */
const codeIn = (block: HTMLPreElement | null) => (block?.textContent ?? "").replace(/\n$/, "");

function CodeBlock({ node: _node, ...props }: ComponentProps<"pre"> & ExtraProps) {
  const block = useRef<HTMLPreElement>(null);
  const [label, setLabel] = useState<"Copy" | "Copied" | "Copy failed">("Copy");
  useEffect(() => {
    if (label === "Copy") return;
    const backToCopy = setTimeout(() => setLabel("Copy"), COPY_OUTCOME_SHOWN_MS);
    return () => clearTimeout(backToCopy);
  }, [label]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(codeIn(block.current));
      setLabel("Copied");
    } catch {
      setLabel("Copy failed");
    }
  };
  return (
    <div className="copyable-code">
      <pre ref={block} {...props} />
      <button type="button" className={`code-copy ${label === "Copy" ? "" : "shown"}`} onClick={copy}>
        {label}
      </button>
    </div>
  );
}

const STREAM_RENDER_INTERVAL_MS = 150;

/** Throttled, not debounced: a debounce would hold the text back for as long as the chunks keep arriving. */
function useThrottledText(text: string) {
  const [shown, setShown] = useState(text);
  const lastShownAt = useRef(0);
  useEffect(() => {
    if (text === shown) return;
    const timer = setTimeout(
      () => {
        lastShownAt.current = Date.now();
        setShown(text);
      },
      Math.max(0, lastShownAt.current + STREAM_RENDER_INTERVAL_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [text, shown]);
  return shown;
}

/** Parsing is the costly part, so a re-render with the same text reuses the last result. */
const RenderedMarkdown = memo(function RenderedMarkdown({ text }: { text: string }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      components={{ a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />, pre: CodeBlock }}
    >
      {text}
    </Markdown>
  );
});

export const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
  const shown = useThrottledText(text);
  return (
    <div className="markdown">
      <RenderedMarkdown text={shown} />
    </div>
  );
});
