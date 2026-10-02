import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function MarkdownText({ text }: { text: string }) {
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
}
