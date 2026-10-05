import type { ToolCallContent } from "@agentclientprotocol/sdk";
import type {
  AdoptMode,
  AskMode,
  CanvasItem,
  CanvasUse,
  ClaudeProgram,
  Conversation,
  ConversationMatches,
  ExternalSession,
  JoinRequest,
  ListedDevice,
  Machine,
  MachineStatus,
  Launch,
  Profile,
  PromptTemplate,
  PublicAddress,
  ReachabilitySettings,
  StatuslineRender,
  StoredEvent,
  TerminalTab,
  Workspace,
  Pastel,
} from "./model.ts";
import type { FindingDecision } from "./review.ts";
import type { LowDataSubscription } from "./low-data.ts";
import type { MentionSuggestion } from "./mentions.ts";
import type { PromptHistoryEntry } from "./prompt-history.ts";
import type { SlashCommand } from "./slash-commands.ts";
import type { SplitAxis } from "./terminal-layout.ts";
import type { SystemNotification } from "./system-notifications.ts";

export interface TerminalSplit {
  terminalId: string;
  axis: SplitAxis;
}

/** The cookie a signed-in page carries; the desktop app sends it too when it listens for system notifications. */
export const TOKEN_COOKIE = "mirador_token";
/**
 * Sent by the relay that shows a machine in the rail: the machine's pages there load canvas libraries from this
 * computer's own copy, as this computer's browser may not trust the machine's certificate.
 */
export const CANVAS_ASSETS_ORIGIN_HEADER = "mirador-canvas-assets-origin";
/**
 * Mirador's own pages edit profiles, so they open /ws with this query parameter to get what each profile launches its
 * agent with: the environment and prelaunch command, which often hold API keys. Other clients, such as the phone app,
 * never show them and never get them.
 */
export const PROFILE_LAUNCH_PARAMETER = "profile-launch";

export type ProfileDraft = Pick<Profile, "name" | "harness" | "environment" | "prelaunch" | "mode" | "bypassPermissions" | "askMode"> & { id?: string };

export type ClientMessage =
  | { type: "workspace.create"; path: string }
  | { type: "workspace.delete"; workspaceId: string }
  | { type: "workspace.set-default-launch"; workspaceId: string; launch: Launch }
  /** Puts the workspace just before another in the sidebar, or last. */
  | { type: "workspace.move"; workspaceId: string; beforeWorkspaceId: string | null }
  | { type: "workspace.set-color"; workspaceId: string; color: Pastel | null }
  | { type: "profile.save"; requestId: string; profile: ProfileDraft }
  | { type: "profile.delete"; profileId: string }
  /** Creates the template, or changes the one with this id. */
  | { type: "prompt-template.save"; template: Pick<PromptTemplate, "id" | "name" | "text"> }
  | { type: "prompt-template.delete"; templateId: string }
  | { type: "settings.set-canvas-use"; canvasUse: CanvasUse }
  | { type: "settings.set-claude-program"; path: string }
  | { type: "conversation.create"; workspaceId: string; launch: Launch }
  /** Puts the conversation just before another of its workspace in the sidebar, or last. */
  | { type: "conversation.move"; conversationId: string; beforeConversationId: string | null }
  | { type: "sessions.list"; requestId: string; workspaceId: string; launch: Launch }
  /** The slash commands the conversation's agent takes, as it last listed them. */
  | { type: "slash-commands.list"; requestId: string; conversationId: string }
  /**
   * What the user typed in the conversation's workspace's other conversations, newest first, for ↑ in the message box;
   * with `ownBeforeSeq`, also what they typed in this conversation before that event, for a client holding only its latest turns.
   */
  | { type: "prompt-history.list"; requestId: string; conversationId: string; ownBeforeSeq?: number }
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
  | { type: "conversation.subscribe"; conversationId: string; lowData?: LowDataSubscription }
  /** The turns before the earliest event a low-data subscriber holds. */
  | { type: "conversation.load-earlier"; requestId: string; conversationId: string; beforeSeq: number; turns: number }
  /** Tool output the low-data form shortened, whole: the content of the stored event its mark names, images still as links. */
  | { type: "tool-output.get"; requestId: string; conversationId: string; seq: number }
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
  | { type: "conversation.job-wait.stop"; conversationId: string; waitId: string }
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
  /** Opens a terminal in a new tab, or beside or below the one `split` names, in its tab. */
  | { type: "terminal.open"; requestId: string; workspaceId: string; split: TerminalSplit | null; columns: number; rows: number }
  | { type: "terminal.replay"; terminalId: string }
  /** Signs the conversation's agent in again, in a new terminal tab of its workspace. */
  | { type: "terminal.open-login"; requestId: string; conversationId: string; columns: number; rows: number }
  | { type: "terminal.follow-job"; requestId: string; conversationId: string; waitId: string; columns: number; rows: number }
  | { type: "terminal.input"; terminalId: string; data: string }
  | { type: "terminal.resize"; terminalId: string; columns: number; rows: number }
  /** With `unlessBusy`, a terminal running a command stays open, and the host answers terminal.busy. */
  | { type: "terminal.close"; terminalId: string; unlessBusy?: boolean }
  /** With `unlessBusy`, a tab where a command runs stays open, and the host answers terminal.busy with its `tabId`. */
  | { type: "terminal.close-tab"; tabId: string; unlessBusy?: boolean }
  | { type: "terminal.clear"; terminalId: string }
  /** What this page shows, and whether you are looking at it: the host notifies only about conversations nobody is looking at. */
  | { type: "presence"; conversationId: string | null; attentive: boolean }
  | { type: "host.restart" }
  | { type: "devices.list" }
  | { type: "devices.invite"; requestId: string }
  | { type: "device.revoke"; deviceId: string }
  /** number is what the approver typed: the number the device asking shows. */
  | { type: "join-request.approve"; requestId: string; joinRequestId: string; number: string }
  | { type: "join-request.deny"; joinRequestId: string }
  /** Saved to config.json for the host's next start; null takes the address out. */
  | { type: "settings.set-public-address"; requestId: string; address: PublicAddress | null }
  | { type: "settings.set-network"; requestId: string; on: boolean }
  /** address is what the user typed or pasted: a name on the network, an address, or an invite link. */
  | { type: "machine.add"; name: string; address: string }
  | { type: "machine.remove"; machineId: string }
  | { type: "machine.set-color"; machineId: string; color: Pastel | null }
  | { type: "machine.join"; requestId: string; machineId: string; code: string; authorityFingerprint: string | null }
  | { type: "machine.ask-to-join"; requestId: string; machineId: string }
  | { type: "search"; requestId: string; query: string };

export type ServerMessage =
  | {
      type: "snapshot";
      workspaces: Workspace[];
      conversations: Conversation[];
      profiles: Profile[];
      promptTemplates: PromptTemplate[];
      canvasUse: CanvasUse;
      claudeProgram: ClaudeProgram;
      /** Where this page loads canvas libraries from: the address it reached the host at may differ from the one agents were given. */
      canvasAssetsOrigin: string;
      agentsCanvasAssetsOrigin: string;
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
  | { type: "settings.claude-program"; claudeProgram: ClaudeProgram }
  | { type: "workspace.upserted"; workspace: Workspace }
  | { type: "workspace.deleted"; workspaceId: string }
  | { type: "conversation.upserted"; conversation: Conversation }
  | { type: "conversation.deleted"; conversationId: string }
  | {
      type: "conversation.history";
      conversationId: string;
      events: StoredEvent[];
      canvas: CanvasItem[];
      /**
       * For a low-data subscriber that held events up to this one: these continue them rather than replace them, and the
       * canvas items, only those changed since the newest change it held, update its own.
       */
      continuesAfter?: number;
      /** For a low-data subscriber: the conversation has turns before these events. */
      hasEarlier?: boolean;
    }
  | { type: "conversation.earlier"; requestId: string; conversationId: string; events: StoredEvent[]; hasEarlier: boolean }
  | { type: "tool-output.got"; requestId: string; content: ToolCallContent[] }
  | { type: "conversation.event"; conversationId: string; event: StoredEvent }
  | { type: "canvas.upserted"; item: CanvasItem }
  | { type: "fs.completions"; requestId: string; directories: string[] }
  | { type: "statusline.rendered"; requestId: string; statusline: StatuslineRender }
  | { type: "sessions.listed"; requestId: string; sessions: ExternalSession[] }
  | { type: "sessions.failed"; requestId: string; message: string }
  | { type: "review.file-read"; requestId: string; lines: string[] }
  | { type: "slash-commands.listed"; requestId: string; commands: SlashCommand[] }
  | { type: "prompt-history.listed"; requestId: string; prompts: string[]; ownEarlier?: PromptHistoryEntry[] }
  | { type: "mentions.suggested"; requestId: string; suggestions: MentionSuggestion[] }
  | { type: "review.file-failed"; requestId: string; message: string }
  | { type: "terminals.listed"; workspaceId: string; tabs: TerminalTab[] }
  | { type: "terminal.opened"; requestId: string; tabId: string; terminalId: string }
  | { type: "terminal.replayed"; terminalId: string; data: string }
  | { type: "terminal.output"; terminalId: string; data: string }
  | { type: "terminal.exited"; terminalId: string; exitCode: number }
  /** The terminal was left open: `command` runs in it. With `tabId`, closing that whole tab was asked. */
  | { type: "terminal.busy"; terminalId: string; command: string; tabId?: string }
  | { type: "terminal.cleared"; terminalId: string }
  | { type: "system-notification"; notification: SystemNotification }
  | { type: "host.code-changed" }
  /** The host is stopping to start again in place; pages reload once they reconnect. */
  | { type: "host.restarting" }
  | { type: "error"; message: string }
  /** thisDeviceId is the device the receiving page signed in as; null when it signed in with the host's own link. */
  | { type: "devices.listed"; devices: ListedDevice[]; thisDeviceId: string | null; reachability: ReachabilitySettings }
  | { type: "devices.invited"; requestId: string; code: string; expiresAt: number }
  | { type: "machines.changed"; machines: Machine[] }
  | { type: "machine.status"; status: MachineStatus }
  /** The machine has the request; it waits there until someone types the number this host shows. */
  | { type: "machine.join-asked"; requestId: string; number: string }
  | { type: "machine.join-answered"; requestId: string; problem: string | null }
  | { type: "join-requests.listed"; joinRequests: JoinRequest[] }
  /** problem says why it was not approved, e.g. a wrong number, which denies it. */
  | { type: "join-request.answered"; requestId: string; problem: string | null }
  | { type: "settings.saved"; requestId: string; problem: string | null }
  /** The conversation with the newest hit first. */
  | { type: "search.results"; requestId: string; conversations: ConversationMatches[] };
