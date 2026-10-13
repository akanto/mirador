import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type RefObject } from "react";
import { suggestedPagePath } from "../shared/canvas-export.ts";
import type { CanvasItem } from "../shared/model.ts";
import { AlreadyThere, copyPageHtml, copyPageImage, downloadPage, savePageToProject } from "./canvas-export.ts";
import { hints } from "./hints.ts";
import { useTypingAidAttributes } from "./typing-aids.ts";

const POPOVER_GAP = 6;
const DONE_NOTE_MS = 4000;
const FAILURE_NOTE_MS = 12_000;

/** Fixed, so the canvas bar doesn't clip what opens under its button. */
function placedBelow(element: HTMLElement): CSSProperties {
  const { bottom, right } = element.getBoundingClientRect();
  return { top: bottom + POPOVER_GAP, right: window.innerWidth - right };
}

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

/** Closes what is open on Escape, or on a press anywhere outside the element. */
function useClosing(open: boolean, inside: RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const closeWhenOutside = (event: PointerEvent) => inside.current?.contains(event.target as Node) || close();
    const closeOnEscape = (event: KeyboardEvent) => event.key === "Escape" && close();
    document.addEventListener("pointerdown", closeWhenOutside);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", closeWhenOutside);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", close);
    };
  }, [open]);
}

/** Copy, download or save a page the agent showed, from the canvas bar. */
export function PageExport({ page, frame }: { page: CanvasItem; frame: RefObject<HTMLIFrameElement | null> }) {
  const root = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<CSSProperties | null>(null);
  const [opened, setOpened] = useState<"menu" | "save" | null>(null);
  const [status, setStatus] = useStatus();
  const close = () => setOpened(null);
  useClosing(opened !== null, root, close);

  const run = async (working: string, action: () => Promise<unknown>, done: string) => {
    close();
    setStatus({ text: working, working: true });
    try {
      await action();
      setStatus({ text: done });
    } catch (error) {
      setStatus({ text: failureText(error), failed: true });
    }
  };
  const copyImage = () =>
    run("Drawing the page…", () => (frame.current ? copyPageImage(frame.current) : Promise.reject(new Error("The page is not shown."))), "Copied as an image");
  const copyHtml = () => run("Copying…", () => copyPageHtml(page.id), "Copied the HTML");
  const download = () => run("Preparing the file…", () => downloadPage(page), "Downloaded");

  return (
    <div className="page-export" ref={root}>
      <button
        type="button"
        className={`page-export-toggle ${opened ? "on" : ""}`}
        aria-haspopup="menu"
        aria-expanded={opened === "menu"}
        data-hint={hints.canvasPageExport}
        onClick={(event) => {
          setPlacement(placedBelow(event.currentTarget));
          setOpened((open) => (open === "menu" ? null : "menu"));
        }}
      >
        Export ▾
      </button>
      {opened === "menu" && (
        <ul role="menu" aria-label="Export the page" className="page-export-menu" style={placement ?? undefined}>
          <li role="none">
            <button type="button" role="menuitem" onClick={copyImage}>
              Copy as image
            </button>
          </li>
          <li role="none">
            <button type="button" role="menuitem" onClick={copyHtml}>
              Copy HTML
            </button>
          </li>
          <li role="separator" />
          <li role="none">
            <button type="button" role="menuitem" onClick={download}>
              Download
            </button>
          </li>
          <li role="none">
            <button type="button" role="menuitem" onClick={() => setOpened("save")}>
              Save to project…
            </button>
          </li>
        </ul>
      )}
      {opened === "save" && (
        <SaveToProject
          page={page}
          style={placement ?? undefined}
          onSaved={(path) => {
            close();
            setStatus({ text: `Saved to ${path}` });
          }}
          onCancel={close}
        />
      )}
      {status && !opened && (
        <div className={`page-export-status ${status.failed ? "failed" : ""}`} role="status" style={placement ?? undefined}>
          {status.text}
        </div>
      )}
    </div>
  );
}

function SaveToProject({ page, style, onSaved, onCancel }: { page: CanvasItem; style?: CSSProperties; onSaved: (path: string) => void; onCancel: () => void }) {
  const [path, setPath] = useState(() => suggestedPagePath(page.title));
  const [problem, setProblem] = useState<string | null>(null);
  const [alreadyThere, setAlreadyThere] = useState(false);
  const [saving, setSaving] = useState(false);
  const typingAidAttributes = useTypingAidAttributes();

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
    <form className="page-save" style={style} onSubmit={save}>
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
