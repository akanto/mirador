import { memo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Parsing is the costly part, so a re-render with the same text reuses the last result. */
export const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
  return (
    <div className="markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{ a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" /> }}
      >
        {text}
      </Markdown>
    </div>
  );
});
