import { useEffect, useState } from "react";

const storageKey = (conversationId: string) => `mirador-draft-${conversationId}`;

function storedDraft(conversationId: string) {
  try {
    return localStorage.getItem(storageKey(conversationId)) ?? "";
  } catch {
    return "";
  }
}

/** What the user typed but hasn't sent, kept per conversation so switching away and back loses nothing. */
export function useDraft(conversationId: string) {
  const [draft, setDraft] = useState(() => storedDraft(conversationId));
  useEffect(() => {
    try {
      if (draft) localStorage.setItem(storageKey(conversationId), draft);
      else localStorage.removeItem(storageKey(conversationId));
    } catch {}
  }, [conversationId, draft]);
  return [draft, setDraft] as const;
}

export const joinDrafts = (...texts: string[]) => texts.filter((text) => text.trim()).join("\n\n");
