import { createContext, useEffect, useState } from "react";
import type { ListedPaths, RestoreFiles, RestorePlan } from "../shared/model.ts";
import { whatChanged, whatWasLeft, type Turn } from "../shared/reverts.ts";
import { connection } from "./connection.ts";
import { hints } from "./hints.ts";
import { Modal } from "./Palette.tsx";

/** What a turn's message offers: going back to it, and putting its files back where the agent cannot go back. */
export interface UndoRequest {
  turn: Turn;
  rewind: boolean;
}

/** How the page asks to go back; the dialog it opens lives at the top of the page, so both the message and the palette reach it. */
export type AskToRevert = (request: UndoRequest) => void;

/** The entries of a long timeline are memoized, so the way to ask reaches each message as context rather than as a prop. */
export const AskToRevert = createContext<AskToRevert>(() => {});

/** What the dialog says while it is up, as the host works it out. */
interface Preview {
  plan: RestorePlan | null;
  /** Which files the plan's counts are. */
  files?: RestoreFiles;
  /** Why the files stay as they are, when they do. */
  filesNote?: string;
  /** Why the conversation cannot go back, when it cannot. */
  cannotRewind?: string;
  /** What a rewind leaves: how many turns go, and the turn it goes back to; null keptFrom: all of them. */
  turnsLeaving?: number;
  keptFrom?: string | null;
}

const previewFiles = (conversationId: string, seq: number) =>
  connection.sendAndAwait(
    (requestId) => ({ type: "conversation.revert-preview", requestId, conversationId, seq }),
    (message, requestId) => {
      if (message.type === "conversation.revert-previewed" && message.requestId === requestId) {
        return { plan: message.plan, ...(message.files && { files: message.files }), ...(message.cannotUndo && { filesNote: message.cannotUndo }) };
      }
      if (message.type === "conversation.revert-failed" && message.requestId === requestId) throw new Error(message.message);
      return undefined;
    },
  );

const previewRewind = (conversationId: string, seq: number) =>
  connection.sendAndAwait(
    (requestId) => ({ type: "conversation.rewind-preview", requestId, conversationId, seq }),
    (message, requestId) => {
      if (message.type === "conversation.rewind-previewed" && message.requestId === requestId) {
        const { plan, files, cannotRewind, filesNote, turnsLeaving, keptFrom } = message;
        return { plan, ...(files && { files }), ...(cannotRewind && { cannotRewind }), ...(filesNote && { filesNote }), ...(turnsLeaving !== undefined && { turnsLeaving }), keptFrom };
      }
      if (message.type === "conversation.rewind-failed" && message.requestId === requestId) throw new Error(message.message);
      return undefined;
    },
  );

const putFilesBack = (conversationId: string, seq: number) =>
  connection.sendAndAwait(
    (requestId) => ({ type: "conversation.revert", requestId, conversationId, seq }),
    (message, requestId) => {
      if (message.type === "conversation.reverted" && message.requestId === requestId) return message.plan;
      if (message.type === "conversation.revert-failed" && message.requestId === requestId) throw new Error(message.message);
      return undefined;
    },
  );

export const rewindTo = (conversationId: string, seq: number, keepFiles = false) =>
  connection.sendAndAwait(
    (requestId) => ({ type: "conversation.rewind", requestId, conversationId, seq, ...(keepFiles && { keepFiles }) }),
    (message, requestId) => {
      if (message.type === "conversation.rewind-done" && message.requestId === requestId) return message.fromSeq;
      if (message.type === "conversation.rewind-failed" && message.requestId === requestId) throw new Error(message.message);
      return undefined;
    },
  );

/** What going back to the turn would do, which the host works out while the dialog is up. */
function usePreview(conversationId: string, seq: number, rewind: boolean) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let showing = true;
    const asked = rewind ? previewRewind(conversationId, seq) : previewFiles(conversationId, seq);
    asked.then(
      (answered) => showing && setPreview(answered),
      (error) => showing && setProblem(error instanceof Error ? error.message : String(error)),
    );
    return () => {
      showing = false;
    };
  }, [conversationId, seq, rewind]);
  return { preview, problem, setProblem };
}

/** What the conversation loses: the turns from this one on, and the agent's own history with them. */
function whatLeaves({ turnsLeaving = 1, keptFrom }: Preview) {
  const turns = turnsLeaving === 1 ? "1 turn leaves" : `${turnsLeaving} turns leave`;
  return keptFrom
    ? `${turns} the conversation, and the agent's own history goes back with ${turnsLeaving === 1 ? "it" : "them"}, to before “${keptFrom}”.`
    : "Every turn leaves the conversation, and the agent starts over with nothing of it.";
}

const putsAnyFileBack = (plan: RestorePlan | null) => plan !== null && plan.restored + plan.removed > 0;

/** What the files do: they go back too, or they stay as they are and this says why. */
function whatFiles(preview: Preview, rewind: boolean, keepFiles: boolean) {
  if (preview.filesNote) return rewind ? `The files stay as they are: ${preview.filesNote}` : preview.filesNote;
  if (!preview.plan) return "";
  if (keepFiles) return "The files stay as they are now, with what the turns that leave did to them.";
  const changed = [`${whatChanged(preview.plan)} since this turn began.`, whatWasLeft(preview.plan)].filter(Boolean).join(" ");
  return rewind ? `The files go back too: ${changed}` : `${changed} The turn above stays in the conversation, and the agent is told the files no longer hold it.`;
}

function FileGroup({ title, listed }: { title: string; listed: ListedPaths }) {
  if (listed.paths.length === 0) return null;
  return (
    <section className="revert-file-group" aria-label={title}>
      <h3>{title}</h3>
      <ul>
        {listed.paths.map((path) => (
          <li key={path}>{path}</li>
        ))}
      </ul>
      {listed.more > 0 && <p className="hint">and {listed.more.toLocaleString("en")} more</p>}
    </section>
  );
}

const listsAnyFile = ({ deleted, putBack, committed }: RestoreFiles) => [deleted, putBack, committed].some(({ paths }) => paths.length > 0);

/** The files behind the summary's counts, shown on asking: what goes, what goes back, and what stays as commits left it. */
function FileList({ files, headMovedElsewhere }: { files: RestoreFiles; headMovedElsewhere: boolean }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="revert-files">
      <button type="button" className="link" aria-expanded={shown} data-hint={hints.revertFiles} onClick={() => setShown(!shown)}>
        {shown ? "Hide the files" : "Show the files"}
      </button>
      {shown && (
        <div className="revert-file-groups">
          <FileGroup title="Deleted" listed={files.deleted} />
          <FileGroup title="Put back as they were" listed={files.putBack} />
          <FileGroup title={headMovedElsewhere ? "Stay as they are" : "Stay as committed"} listed={files.committed} />
        </div>
      )}
    </div>
  );
}

export function RevertDialog({ conversationId, turn, rewind, onClose }: { conversationId: string; turn: Turn; rewind: boolean; onClose: () => void }) {
  const { preview, problem, setProblem } = usePreview(conversationId, turn.seq, rewind);
  const [working, setWorking] = useState(false);
  const [keepFiles, setKeepFiles] = useState(false);
  const go = async () => {
    setWorking(true);
    try {
      await (rewind ? rewindTo(conversationId, turn.seq, keepFiles) : putFilesBack(conversationId, turn.seq));
      onClose();
    } catch (error) {
      setWorking(false);
      setProblem(error instanceof Error ? error.message : String(error));
    }
  };
  const blocked = problem ?? preview?.cannotRewind ?? (rewind ? undefined : preview?.filesNote);
  const files = preview && !blocked ? whatFiles(preview, rewind, keepFiles) : "";
  const offersToKeepFiles = rewind && preview && !blocked && !preview.filesNote && putsAnyFileBack(preview.plan);
  const listedFiles = preview && !blocked && !preview.filesNote && !keepFiles && preview.files && listsAnyFile(preview.files) ? preview.files : null;
  return (
    <Modal label={rewind ? "Rewind to here" : "Undo the files of a turn"} className="revert" onClose={onClose}>
      <h2>{rewind ? "Rewind to here" : "Undo the files"}</h2>
      <p className="revert-turn">{turn.text}</p>
      {blocked ? (
        <p className="revert-summary">{blocked}</p>
      ) : preview ? (
        <>
          {rewind && <p className="revert-summary">{whatLeaves(preview)}</p>}
          {files && <p className="revert-summary">{files}</p>}
          {listedFiles && <FileList files={listedFiles} headMovedElsewhere={preview.plan?.committed?.commits === null} />}
          {offersToKeepFiles && (
            <label className="revert-files-choice" data-hint={hints.rewindPutFilesBack}>
              <input type="checkbox" checked={!keepFiles} onChange={(event) => setKeepFiles(!event.target.checked)} />
              Put the files back too
            </label>
          )}
        </>
      ) : (
        <p className="revert-summary">Checking what would change…</p>
      )}
      <div className="form-actions">
        <button type="button" className="link" onClick={onClose}>
          Cancel
        </button>
        {preview && !blocked && (
          <button type="button" className="primary" data-hint={rewind ? hints.rewindConfirm : hints.undoFilesConfirm} disabled={working} onClick={go}>
            {working ? (rewind ? "Going back…" : "Putting the files back…") : rewind ? "Rewind" : "Put the files back"}
          </button>
        )}
      </div>
    </Modal>
  );
}

/** On the message that began a turn: back to before it, or, where the agent cannot go back, its files alone. */
export function UndoButton({ turn, rewind, ask }: { turn: Turn; rewind: boolean; ask: AskToRevert }) {
  return (
    <button type="button" className="link undo-files" data-hint={rewind ? hints.rewind : hints.undoFiles} onClick={() => ask({ turn, rewind })}>
      {rewind ? "Rewind to here" : "Undo files"}
    </button>
  );
}
