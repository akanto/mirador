import type {
  AdoptMode,
  AskMode,
  CanvasItem,
  Conversation,
  ExternalSession,
  Launch,
  Profile,
  StatuslineRender,
  StoredEvent,
  Workspace,
} from "./model.ts";

export type ProfileDraft = Pick<Profile, "name" | "harness" | "environment" | "prelaunch"> & { id?: string };

export type ClientMessage =
  | { type: "workspace.create"; path: string }
  | { type: "workspace.delete"; workspaceId: string }
  | { type: "workspace.set-default-launch"; workspaceId: string; launch: Launch }
  | { type: "profile.save"; requestId: string; profile: ProfileDraft }
  | { type: "profile.delete"; profileId: string }
  | { type: "conversation.create"; workspaceId: string; launch: Launch }
  | { type: "sessions.list"; requestId: string; workspaceId: string; launch: Launch }
  | {
      type: "conversation.adopt";
      workspaceId: string;
      launch: Launch;
      session: Pick<ExternalSession, "sessionId" | "title">;
      mode: AdoptMode;
    }
  | { type: "conversation.delete"; conversationId: string }
  | { type: "conversation.rename"; conversationId: string; title: string }
  | { type: "conversation.set-profile"; conversationId: string; profileId: string | null }
  | { type: "conversation.subscribe"; conversationId: string }
  | { type: "conversation.prompt"; conversationId: string; text: string }
  | { type: "conversation.cancel"; conversationId: string }
  | { type: "conversation.run-command"; conversationId: string; command: string }
  | { type: "conversation.stop-command"; conversationId: string; commandId: string }
  | { type: "conversation.drop-command-outputs"; conversationId: string; commandIds: string[] }
  | { type: "conversation.queue.edit"; conversationId: string; messageId: string; text: string }
  | { type: "conversation.queue.remove"; conversationId: string; messageId: string }
  | { type: "conversation.set-ask-mode"; conversationId: string; askMode: AskMode }
  | { type: "conversation.set-bypass-permissions"; conversationId: string; bypassPermissions: boolean }
  | { type: "conversation.set-config"; conversationId: string; configId: string; value: string | boolean }
  | { type: "permission.respond"; conversationId: string; permissionId: string; optionId: string | null }
  | { type: "ask.answer"; itemId: string; label: string; note?: string }
  | { type: "canvas.report"; itemId: string; errors: string[] }
  | { type: "fs.complete"; requestId: string; prefix: string }
  | { type: "statusline.render"; requestId: string; conversationId: string; columns: number; runCommand: boolean }
  | { type: "terminals.attach"; workspaceId: string | null }
  | { type: "terminal.open"; workspaceId: string; columns: number; rows: number }
  | { type: "terminal.replay"; terminalId: string }
  | { type: "terminal.input"; terminalId: string; data: string }
  | { type: "terminal.resize"; terminalId: string; columns: number; rows: number }
  | { type: "terminal.close"; terminalId: string };

export type ServerMessage =
  | {
      type: "snapshot";
      workspaces: Workspace[];
      conversations: Conversation[];
      profiles: Profile[];
      canvasAssetsOrigin: string;
      homeDir: string;
    }
  | { type: "profile.upserted"; profile: Profile }
  | { type: "profile.deleted"; profileId: string }
  | { type: "profile.saved"; requestId: string; profileId: string }
  | { type: "workspace.upserted"; workspace: Workspace }
  | { type: "workspace.deleted"; workspaceId: string }
  | { type: "conversation.upserted"; conversation: Conversation }
  | { type: "conversation.deleted"; conversationId: string }
  | { type: "conversation.history"; conversationId: string; events: StoredEvent[]; canvas: CanvasItem[] }
  | { type: "conversation.event"; conversationId: string; event: StoredEvent }
  | { type: "canvas.upserted"; item: CanvasItem }
  | { type: "fs.completions"; requestId: string; directories: string[] }
  | { type: "statusline.rendered"; requestId: string; statusline: StatuslineRender }
  | { type: "sessions.listed"; requestId: string; sessions: ExternalSession[] }
  | { type: "sessions.failed"; requestId: string; message: string }
  | { type: "terminals.listed"; workspaceId: string; terminalIds: string[] }
  | { type: "terminal.replayed"; terminalId: string; data: string }
  | { type: "terminal.output"; terminalId: string; data: string }
  | { type: "terminal.exited"; terminalId: string; exitCode: number }
  | { type: "error"; message: string };
