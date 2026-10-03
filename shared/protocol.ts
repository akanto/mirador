import type {
  AdoptMode,
  AskMode,
  CanvasItem,
  CanvasUse,
  Conversation,
  ConversationMatches,
  Device,
  ExternalSession,
  Machine,
  MachineStatus,
  Launch,
  Profile,
  PromptTemplate,
  PublicAddress,
  StatuslineRender,
  StoredEvent,
  TerminalTab,
  Workspace,
  WorkspaceColor,
} from "./model.ts";
import type { FindingDecision } from "./review.ts";
import type { MentionSuggestion } from "./mentions.ts";
import type { SlashCommand } from "./slash-commands.ts";
import type { SystemNotification } from "./system-notifications.ts";

/** The cookie a signed-in page carries; the desktop app sends it too when it listens for system notifications. */
export const TOKEN_COOKIE = "mirador_token";

export type ProfileDraft = Pick<Profile, "name" | "harness" | "environment" | "prelaunch" | "mode" | "bypassPermissions" | "askMode"> & { id?: string };

export type ClientMessage =
  | { type: "workspace.create"; path: string }
  | { type: "workspace.delete"; workspaceId: string }
  | { type: "workspace.set-default-launch"; workspaceId: string; launch: Launch }
  /** Puts the workspace just before another in the sidebar, or last. */
  | { type: "workspace.move"; workspaceId: string; beforeWorkspaceId: string | null }
  | { type: "workspace.set-color"; workspaceId: string; color: WorkspaceColor | null }
  | { type: "profile.save"; requestId: string; profile: ProfileDraft }
  | { type: "profile.delete"; profileId: string }
  /** Creates the template, or changes the one with this id. */
  | { type: "prompt-template.save"; template: Pick<PromptTemplate, "id" | "name" | "text"> }
  | { type: "prompt-template.delete"; templateId: string }
  | { type: "settings.set-canvas-use"; canvasUse: CanvasUse }
  | { type: "conversation.create"; workspaceId: string; launch: Launch }
  /** Puts the conversation just before another of its workspace in the sidebar, or last. */
  | { type: "conversation.move"; conversationId: string; beforeConversationId: string | null }
  | { type: "sessions.list"; requestId: string; workspaceId: string; launch: Launch }
  /** The slash commands the conversation's agent takes, as it last listed them. */
  | { type: "slash-commands.list"; requestId: string; conversationId: string }
  /** What the user typed in the conversation's workspace's other conversations, newest first, for ↑ in the message box. */
  | { type: "prompt-history.list"; requestId: string; conversationId: string }
  /** Paths for the @mention being written: what follows the @, completed as a path or searched for in the workspace. */
  | { type: "mentions.suggest"; requestId: string; conversationId: string; query: string }
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
  | { type: "conversation.unsubscribe"; conversationId: string }
  | { type: "conversation.prompt"; conversationId: string; text: string; imageIds: string[]; afterTurn?: boolean }
  | { type: "conversation.cancel"; conversationId: string }
  | { type: "conversation.run-command"; conversationId: string; command: string }
  | { type: "conversation.stop-command"; conversationId: string; commandId: string }
  | { type: "conversation.drop-command-outputs"; conversationId: string; commandIds: string[] }
  | { type: "conversation.queue.edit"; conversationId: string; messageId: string; text: string }
  | { type: "conversation.queue.remove"; conversationId: string; messageId: string }
  | { type: "conversation.queue.move"; conversationId: string; messageId: string; beforeMessageId: string | null }
  | { type: "conversation.queue.set-after-turn"; conversationId: string; messageId: string; afterTurn: boolean }
  | { type: "conversation.usage-limit.continue"; conversationId: string }
  | { type: "conversation.usage-limit.stop-waiting"; conversationId: string }
  | { type: "conversation.set-ask-mode"; conversationId: string; askMode: AskMode }
  | { type: "conversation.set-bypass-permissions"; conversationId: string; bypassPermissions: boolean }
  | { type: "conversation.set-config"; conversationId: string; configId: string; value: string | boolean }
  | { type: "permission.respond"; conversationId: string; permissionId: string; optionId: string | null }
  | { type: "ask.answer"; itemId: string; label: string; note?: string }
  | { type: "canvas.report"; itemId: string; errors: string[] }
  | { type: "review.update-finding"; itemId: string; findingId: string; decision?: FindingDecision; body?: string }
  | { type: "review.update-answer"; itemId: string; answerId: string; decision?: FindingDecision; body?: string; resolve?: boolean }
  /** Adds the kept findings to the user's pending review on the pull request; the user submits it on GitHub. */
  | { type: "review.post"; itemId: string }
  | { type: "review.open-in-editor"; itemId: string; path: string; line: number }
  /** The reviewed version of a changed file, for showing the lines around the diff's hunks. */
  | { type: "review.read-file"; requestId: string; itemId: string; path: string }
  | { type: "fs.complete"; requestId: string; prefix: string }
  | { type: "statusline.render"; requestId: string; conversationId: string; columns: number; runCommand: boolean }
  | { type: "terminals.attach"; workspaceId: string | null }
  | { type: "terminal.open"; requestId: string; workspaceId: string; tabId: string | null; columns: number; rows: number }
  | { type: "terminal.replay"; terminalId: string }
  /** Signs the conversation's agent in again, in a new terminal tab of its workspace. */
  | { type: "terminal.open-login"; requestId: string; conversationId: string; columns: number; rows: number }
  | { type: "terminal.input"; terminalId: string; data: string }
  | { type: "terminal.resize"; terminalId: string; columns: number; rows: number }
  | { type: "terminal.close"; terminalId: string }
  | { type: "terminal.close-tab"; tabId: string }
  | { type: "terminal.clear"; terminalId: string }
  /** What this page shows, and whether you are looking at it: the host notifies only about conversations nobody is looking at. */
  | { type: "presence"; conversationId: string | null; attentive: boolean }
  | { type: "host.restart" }
  | { type: "devices.list" }
  | { type: "devices.invite"; requestId: string }
  | { type: "device.revoke"; deviceId: string }
  /** Saved to config.json for the host's next start; null takes the address out. */
  | { type: "settings.set-public-address"; requestId: string; address: PublicAddress | null }
  /** address is what the user typed or pasted: a name on the network, an address, or an invite link. */
  | { type: "machine.add"; name: string; address: string }
  | { type: "machine.remove"; machineId: string }
  | { type: "machine.join"; requestId: string; machineId: string; code: string }
  | { type: "search"; requestId: string; query: string };

export type ServerMessage =
  | {
      type: "snapshot";
      workspaces: Workspace[];
      conversations: Conversation[];
      profiles: Profile[];
      promptTemplates: PromptTemplate[];
      canvasUse: CanvasUse;
      canvasAssetsOrigin: string;
      machines: Machine[];
      machineStatuses: MachineStatus[];
      homeDir: string;
      /** Fresh for each start of the host process. */
      hostRunId: string;
      /** Mirador's own host source was edited since this host started. */
      hostCodeChanged: boolean;
    }
  | { type: "profile.upserted"; profile: Profile }
  | { type: "profile.deleted"; profileId: string }
  | { type: "profile.saved"; requestId: string; profileId: string }
  | { type: "prompt-template.upserted"; template: PromptTemplate }
  | { type: "prompt-template.deleted"; templateId: string }
  | { type: "settings.canvas-use"; canvasUse: CanvasUse }
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
  | { type: "review.file-read"; requestId: string; lines: string[] }
  | { type: "slash-commands.listed"; requestId: string; commands: SlashCommand[] }
  | { type: "prompt-history.listed"; requestId: string; prompts: string[] }
  | { type: "mentions.suggested"; requestId: string; suggestions: MentionSuggestion[] }
  | { type: "review.file-failed"; requestId: string; message: string }
  | { type: "terminals.listed"; workspaceId: string; tabs: TerminalTab[] }
  | { type: "terminal.opened"; requestId: string; tabId: string; terminalId: string }
  | { type: "terminal.replayed"; terminalId: string; data: string }
  | { type: "terminal.output"; terminalId: string; data: string }
  | { type: "terminal.exited"; terminalId: string; exitCode: number }
  | { type: "terminal.cleared"; terminalId: string }
  | { type: "system-notification"; notification: SystemNotification }
  | { type: "host.code-changed" }
  /** The host is stopping to start again in place; pages reload once they reconnect. */
  | { type: "host.restarting" }
  | { type: "error"; message: string }
  /**
   * thisDeviceId is the device the receiving page signed in as; null when it signed in with the host's own link.
   * publicAddress is the one the host runs with; savedPublicAddress is in config.json and may wait for a restart.
   */
  | {
      type: "devices.listed";
      devices: Device[];
      thisDeviceId: string | null;
      publicAddress: PublicAddress | null;
      savedPublicAddress: PublicAddress | null;
      publicAddressSetByEnvironment: boolean;
    }
  | { type: "devices.invited"; requestId: string; code: string; expiresAt: number }
  | { type: "machines.changed"; machines: Machine[] }
  | { type: "machine.status"; status: MachineStatus }
  | { type: "machine.join-answered"; requestId: string; problem: string | null }
  | { type: "settings.public-address-saved"; requestId: string; problem: string | null }
  /** The conversation with the newest hit first. */
  | { type: "search.results"; requestId: string; conversations: ConversationMatches[] };
