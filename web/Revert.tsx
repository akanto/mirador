import { createContext, useEffect, useState } from "react";
import type { RestorePlan } from "../shared/model.ts";
import { whatChanged, type UndoableTurn } from "../shared/reverts.ts";
import { connection } from "./connection.ts";
import { hints } from "./hints.ts";
import { Modal } from "./Palette.tsx";

/** How the page asks to undo a turn; the dialog it opens lives at the top of the page, so both the message and the palette reach it. */
export type AskToRevert = (turn: UndoableTurn) => void;

/** The entries of a long timeline are memoized, so the way to ask reaches each message as context rather than as a prop. */
export const AskToUndoFiles = createContext<AskToRevert>(() => {});

interface Preview {
  plan: RestorePlan | null;
  cannotUndo?: string;
}

const previewRevert = (conversationId: string, seq: number) =>
  connection.sendAndAwait(
    (requestId) => ({ type: "conversation.revert-preview", requestId, conversationId, seq }),
    (message, requestId) => {
      if (message.type === "conversation.revert-previewed" && message.requestId === requestId) return { plan: message.plan, cannotUndo: message.cannotUndo };
      if (message.type === "conversation.revert-failed" && message.requestId === requestId) throw new Error(message.message);
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

/** What undoing the turn would do to the files, which the host works out while the dialog is up. */
function usePreview(conversationId: string, seq: number) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let showing = true;
    previewRevert(conversationId, seq).then(
      (answered) => showing && setPreview(answered),
      (error) => showing && setProblem(error instanceof Error ? error.message : String(error)),
    );
    return () => {
      showing = false;
    };
  }, [conversationId, seq]);
  return { preview, problem, setProblem };
}

export function RevertDialog({ conversationId, turn, onClose }: { conversationId: string; turn: UndoableTurn; onClose: () => void }) {
  const { preview, problem, setProblem } = usePreview(conversationId, turn.seq);
  const [undoing, setUndoing] = useState(false);

  const undo = async () => {
    setUndoing(true);
    try {
      await putFilesBack(conversationId, turn.seq);
      onClose();
    } catch (error) {
      setUndoing(false);
      setProblem(error instanceof Error ? error.message : String(error));
    }
  };

  const plan = preview?.plan;
  const cannotUndo = problem ?? preview?.cannotUndo;
  return (
    <Modal label="Undo the files of a turn" className="revert" onClose={onClose}>
      <h2>Undo the files</h2>
      <p className="revert-turn">{turn.text}</p>
      {cannotUndo ? (
        <p className="revert-summary">{cannotUndo}</p>
      ) : plan ? (
        <p className="revert-summary">
          {whatChanged(plan)} since this turn began. The turn above stays in the conversation, and the agent is told the files no longer hold it.
        </p>
      ) : (
        <p className="revert-summary">Checking what would change…</p>
      )}
      <div className="form-actions">
        <button type="button" className="link" onClick={onClose}>
          Cancel
        </button>
        {plan && (
          <button type="button" className="primary" data-hint={hints.undoFilesConfirm} disabled={undoing} onClick={undo}>
            {undoing ? "Putting the files back…" : "Put the files back"}
          </button>
        )}
      </div>
    </Modal>
  );
}

/** On the message that began a turn: puts the workspace's files back to how they were before that turn. */
export function UndoFilesButton({ turn, ask }: { turn: UndoableTurn; ask: AskToRevert }) {
  return (
    <button type="button" className="link undo-files" data-hint={hints.undoFiles} onClick={() => ask(turn)}>
      Undo files
    </button>
  );
}
