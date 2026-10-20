import { useEffect, useRef } from "react";
import { connection } from "./connection.ts";
import type { AppAction, AppState } from "./state.ts";

/**
 * Before a link opens a file outside the workspace that the agent did not change: names the file that would open, and
 * opens that very file, so a link changed meanwhile cannot open another one. It takes the focus on Cancel, so a stray
 * Enter opens nothing.
 */
export function FileToOpenPrompt({ fileToOpen, dispatch }: { fileToOpen: AppState["fileToOpen"]; dispatch: (action: AppAction) => void }) {
  const cancelButton = useRef<HTMLButtonElement>(null);
  useEffect(() => cancelButton.current?.focus(), [fileToOpen]);
  if (!fileToOpen) return null;
  const cancel = () => dispatch({ type: "dismiss-file-to-open" });
  const open = () => {
    connection.send({ type: "files.open", conversationId: fileToOpen.conversationId, path: fileToOpen.file, ownerAgreed: true });
    cancel();
  };
  return (
    <section
      className="file-to-open"
      role="alertdialog"
      aria-label="Open a file outside this workspace?"
      onKeyDown={(event) => {
        if (event.key === "Escape") cancel();
      }}
    >
      <h2>Open a file outside this workspace?</h2>
      <p>
        <code>{fileToOpen.file}</code> is outside this workspace, and the agent did not change it in this conversation.
      </p>
      <div className="actions">
        <button type="button" className="primary" onClick={open}>
          Open
        </button>
        <button ref={cancelButton} type="button" onClick={cancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}
