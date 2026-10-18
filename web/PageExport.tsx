import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode, type RefObject } from "react";
import { markdownPagePath, suggestedPagePath, type MarkdownDelivery } from "../shared/canvas-export.ts";
import type { ShowItem } from "../shared/model.ts";
import { placedBelow, useClosing, type BarMenuEntry } from "./BarMenu.tsx";
import { useEnterWhileBusy } from "./busy-sending.ts";
import { AlreadyThere, askAgentForMarkdown, copyPageHtml, copyPageImage, downloadPage, savePageToProject } from "./canvas-export.ts";
import { inDesktopApp } from "./desktop-bridge.ts";
import { useTypingAidAttributes } from "./typing-aids.ts";

const DONE_NOTE_MS = 4000;
const FAILURE_NOTE_MS = 12_000;

interface Status {
  text: string;
  working?: boolean;
  failed?: boolean;
}

/** A note of how the last action went, which goes away by itself once the action is over: later when it failed, to be read. */
function useStatus() {
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => {
    if (!status || status.working) return;
    const timer = setTimeout(() => setStatus(null), status.failed ? FAILURE_NOTE_MS : DONE_NOTE_MS);
    return () => clearTimeout(timer);
  }, [status]);
  return [status, setStatus] as const;
}

const failureText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Copy, download or save the page the agent showed: the menu entries, for whichever bar menu holds them, and what they
 * open, the Save form and a note of how it went, under the menu's button.
 */
export function usePageExport(page: ShowItem | undefined, frame: RefObject<HTMLIFrameElement | null>): { entries: BarMenuEntry[]; opened: ReactNode } {
  const [placement, setPlacement] = useState<CSSProperties>();
  const [saveFormOpen, setSaveFormOpen] = useState(false);
  const [status, setStatus] = useStatus();
  const enterWhileBusy = useEnterWhileBusy();
  useEffect(() => setSaveFormOpen(false), [page?.id]);
  if (!page) return { entries: [], opened: null };

  const run = async (opener: HTMLElement, working: string, action: () => Promise<unknown>, done: string) => {
    setPlacement(placedBelow(opener));
    setSaveFormOpen(false);
    setStatus({ text: working, working: true });
    try {
      await action();
      setStatus({ text: done });
    } catch (error) {
      setStatus({ text: failureText(error), failed: true });
    }
  };
  const copyImage = () => (frame.current ? copyPageImage(frame.current) : Promise.reject(new Error("The page is not shown.")));
  const askForMarkdown = (label: string, delivery: MarkdownDelivery, done: string): BarMenuEntry => ({
    label,
    onChoose: (opener) => run(opener, "Asking the agent…", async () => askAgentForMarkdown(page, delivery, enterWhileBusy === "after-turn"), done),
  });
  const download: BarMenuEntry ={ label: "Download", onChoose: (opener) => run(opener, "Preparing the file…", () => downloadPage(page), "Downloaded") };
  const saveToProject: BarMenuEntry = {
    label: "Save to project…",
    onChoose: (opener) => {
      setPlacement(placedBelow(opener));
      setStatus(null);
      setSaveFormOpen(true);
    },
  };
  // The desktop app's webview puts downloads in ~/Downloads without a word, so there the file is only saved to the project.
  const [firstSaving, ...otherSaving] = inDesktopApp() ? [saveToProject] : [download, saveToProject];
  const entries: BarMenuEntry[] = [
    { label: "Copy as image", onChoose: (opener) => run(opener, "Drawing the page…", copyImage, "Copied as an image") },
    { label: "Copy HTML", onChoose: (opener) => run(opener, "Copying…", () => copyPageHtml(page.id), "Copied the HTML") },
    { ...askForMarkdown("Ask agent for Markdown", "reply", "Asked the agent. The Markdown comes in the chat."), separatorBefore: true },
    askForMarkdown("Ask agent to save Markdown file", "file", `Asked the agent. The Markdown comes in the chat and in ${markdownPagePath(page.title)}.`),
    { ...firstSaving!, separatorBefore: true },
    ...otherSaving,
  ];
  const opened = saveFormOpen ? (
    <SaveToProject
      key={page.id}
      page={page}
      style={placement}
      onSaved={(path) => {
        setSaveFormOpen(false);
        setStatus({ text: `Saved to ${path}` });
      }}
      onCancel={() => setSaveFormOpen(false)}
    />
  ) : (
    status && (
      <div className={`page-export-status ${status.failed ? "failed" : ""}`} role="status" style={placement}>
        {status.text}
      </div>
    )
  );
  return { entries, opened };
}

function SaveToProject({ page, style, onSaved, onCancel }: { page: ShowItem; style?: CSSProperties; onSaved: (path: string) => void; onCancel: () => void }) {
  const [path, setPath] = useState(() => suggestedPagePath(page.title));
  const [problem, setProblem] = useState<string | null>(null);
  const [alreadyThere, setAlreadyThere] = useState(false);
  const [saving, setSaving] = useState(false);
  const typingAidAttributes = useTypingAidAttributes();
  const form = useRef<HTMLFormElement>(null);
  useClosing(true, form, onCancel);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      onSaved(await savePageToProject(page.id, path, alreadyThere));
    } catch (error) {
      setAlreadyThere(error instanceof AlreadyThere);
      setProblem(failureText(error));
      setSaving(false);
    }
  };
  return (
    <form ref={form} className="page-save" style={style} onSubmit={save}>
      <label>
        Save in the project as
        <input
          autoFocus
          spellCheck={false}
          {...typingAidAttributes}
          value={path}
          onChange={(event) => {
            setPath(event.target.value);
            setAlreadyThere(false);
            setProblem(null);
          }}
        />
      </label>
      {problem && (
        <p className="page-save-problem" role="alert">
          {problem}
          {alreadyThere && " Replace it?"}
        </p>
      )}
      <div className="page-save-buttons">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={saving || !path.trim()}>
          {alreadyThere ? "Replace" : "Save"}
        </button>
      </div>
    </form>
  );
}
