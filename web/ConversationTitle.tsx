import { useState, type KeyboardEvent } from "react";
import type { Conversation } from "../shared/model.ts";
import { connection } from "./connection.ts";

/** A conversation's title that turns into a text field for renaming: Enter or leaving the field saves, Esc cancels. */
export function ConversationTitle({
  conversation,
  startEditingOn,
  className,
}: {
  conversation: Conversation;
  startEditingOn: "click" | "double-click";
  className: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  const save = () => {
    const title = draft?.trim();
    setDraft(null);
    if (title && title !== conversation.title) connection.send({ type: "conversation.rename", conversationId: conversation.id, title });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") save();
    if (event.key === "Escape") setDraft(null);
  };

  if (draft !== null) {
    return (
      <input
        autoFocus
        className={`${className} rename`}
        aria-label="Conversation name"
        value={draft}
        onFocus={(event) => event.target.select()}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={save}
        onClick={(event) => event.stopPropagation()}
      />
    );
  }
  const startEditing = () => setDraft(conversation.title);
  return (
    <span
      className={`${className} renamable`}
      title={`${conversation.title} (${startEditingOn === "click" ? "click" : "double-click"} to rename)`}
      data-rename-trigger={startEditingOn}
      onClick={startEditingOn === "click" ? startEditing : undefined}
      onDoubleClick={startEditingOn === "double-click" ? startEditing : undefined}
    >
      {conversation.title}
    </span>
  );
}
