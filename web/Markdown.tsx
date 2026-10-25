import { createContext, memo, useContext, useEffect, useRef, useState, type ComponentProps } from "react";
import Markdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { isFromAnotherSite, siteOf, useExternalImagesBlocked } from "./external-images.ts";
import { hints } from "./hints.ts";
import { looksLikeFilePath } from "../shared/file-paths.ts";
import { connection } from "./connection.ts";

const COPY_OUTCOME_SHOWN_MS = 1_500;

/** The block's text as written: markdown ends a code block's last line with a line break the author did not write. */
const codeIn = (block: HTMLPreElement | null) => (block?.textContent ?? "").replace(/\n$/, "");

const InsideCodeBlock = createContext(false);

/** The conversation whose files the agent's paths in a text name, or null where there is none to open them in. */
const FilesOfConversation = createContext<string | null>(null);

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
      <pre ref={block} {...props}>
        <InsideCodeBlock.Provider value={true}>{props.children}</InsideCodeBlock.Provider>
      </pre>
      <button type="button" className={`code-copy ${label === "Copy" ? "" : "shown"}`} onClick={copy}>
        {label}
      </button>
    </div>
  );
}

/** Whether images from other sites show as links, where the page's own image policy isn't the one that applies, as in a plugin's canvas view. */
export const ExternalImagesBlocked = createContext<boolean | null>(null);

/** A badge is an image inside a link, and a link cannot hold another. */
const InsideLink = createContext(false);

function MarkdownLink({ node: _node, children, ...props }: ComponentProps<"a"> & ExtraProps) {
  return (
    <a {...props} target="_blank" rel="noreferrer">
      <InsideLink.Provider value={true}>{children}</InsideLink.Provider>
    </a>
  );
}

function MarkdownImage({ node: _node, ...props }: ComponentProps<"img"> & ExtraProps) {
  const blockedByThisPage = useExternalImagesBlocked();
  const externalImagesBlocked = useContext(ExternalImagesBlocked) ?? blockedByThisPage;
  const insideLink = useContext(InsideLink);
  const source = typeof props.src === "string" ? props.src : "";
  if (!externalImagesBlocked || !isFromAnotherSite(source, location.origin)) return <img {...props} />;
  const site = siteOf(source, location.origin);
  const label = props.alt ? `${props.alt} (image from ${site})` : `Image from ${site}`;
  if (insideLink) return <span className="blocked-image">{label}</span>;
  return (
    <a href={source} target="_blank" rel="noreferrer" className="blocked-image" data-hint={hints.blockedImage}>
      {label}
    </a>
  );
}

function MarkdownCode({ node: _node, children, ...props }: ComponentProps<"code"> & ExtraProps) {
  const conversationId = useContext(FilesOfConversation);
  const insideCodeBlock = useContext(InsideCodeBlock);
  const text = typeof children === "string" ? children : "";
  if (!conversationId || insideCodeBlock || !looksLikeFilePath(text)) return <code {...props}>{children}</code>;
  return (
    <button type="button" className="file-link" data-hint={hints.openFile} onClick={() => connection.send({ type: "files.open", conversationId, path: text })}>
      <code>{text}</code>
    </button>
  );
}

const markdownComponents: Components = { a: MarkdownLink, img: MarkdownImage, pre: CodeBlock, code: MarkdownCode };

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
    <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
      {text}
    </Markdown>
  );
});

export const MarkdownText = memo(function MarkdownText({ text, conversationId }: { text: string; conversationId?: string }) {
  const shown = useThrottledText(text);
  return (
    <FilesOfConversation.Provider value={conversationId ?? null}>
      <div className="markdown">
        <RenderedMarkdown text={shown} />
      </div>
    </FilesOfConversation.Provider>
  );
});
