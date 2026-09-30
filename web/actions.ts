import type { Dispatch } from "react";
import type { Workspace } from "../shared/model.ts";
import { connection } from "./connection.ts";
import type { AppAction } from "./state.ts";

export function startConversationIn(workspace: Workspace, dispatch: Dispatch<AppAction>) {
  dispatch({ type: "awaiting-conversation", workspaceId: workspace.id });
  connection.send({ type: "conversation.create", workspaceId: workspace.id, launch: workspace.defaultLaunch });
}

export function startRenamingOpenConversation() {
  document.querySelector<HTMLElement>('.chat-header [data-rename-trigger="click"]')?.click();
}

/** The canvas takes focus on the control the user most likely wants: an answer button, else the page itself. */
export function focusPane(pane: "chat" | "canvas") {
  if (pane === "chat") return document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus();
  const panel = document.querySelector(".canvas-panel");
  const target =
    panel?.querySelector<HTMLElement>(".canvas-body .choose") ??
    panel?.querySelector<HTMLElement>(".canvas-body iframe") ??
    panel?.querySelector<HTMLElement>(".canvas-tab.active");
  target?.focus();
}
