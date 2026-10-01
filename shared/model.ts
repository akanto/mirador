import type {
  PermissionOption,
  SessionConfigOption,
  SessionUpdate,
  StopReason,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";

export type HarnessId = "claude" | "opencode";

export const harnessLabels: Record<HarnessId, string> = {
  claude: "Claude Code",
  opencode: "opencode",
};

export const harnessIds = Object.keys(harnessLabels) as HarnessId[];

export type AskMode = "wait" | "next-message";

/** How to launch an agent: extra environment and a command to run first. No profile means the host's own environment. */
export interface Profile {
  id: string;
  name: string;
  /** Fixed once created: the profile's conversations keep running on this agent. */
  harness: HarnessId;
  environment: string;
  prelaunch: string;
  createdAt: number;
}

/** What a new conversation starts: an agent, with one of its profiles or with none. */
export interface Launch {
  harness: HarnessId;
  profileId: string | null;
}

export function launchLabel(launch: Launch, profiles: Profile[]): string {
  const profile = profiles.find(({ id }) => id === launch.profileId);
  return profile ? `${profile.name} · ${harnessLabels[profile.harness]}` : harnessLabels[launch.harness];
}

export type ConversationStatus = "idle" | "starting" | "running" | "error";

/** What Claude Code is doing with the conversation's session in a terminal, when it is open in one too. */
export type TerminalActivity = "working" | "waiting" | "idle";

export const terminalActivityLabels: Record<TerminalActivity, string> = { working: "working", waiting: "waiting for you", idle: "idle" };

export interface Workspace {
  id: string;
  name: string;
  path: string;
  defaultLaunch: Launch;
  createdAt: number;
}

export interface QueuedMessage {
  id: string;
  text: string;
}

export interface ContextUsage {
  used: number;
  size: number;
  cost: { amount: number; currency: string } | null;
}

/** The host's part of a conversation's statusline; the page adds what it already knows. */
export interface StatuslineRender {
  gitBranch: string | null;
  /** Claude Code's `statusLine` command from the conversation's Claude settings, when one is set. */
  command: string | null;
  /** What the command printed, ANSI colours and all; null when it was not run or did not succeed. */
  output: string | null;
  error: string | null;
}

export interface Conversation {
  id: string;
  workspaceId: string;
  harness: HarnessId;
  profileId: string | null;
  title: string;
  /** Once the user names a conversation, titles from the agent or the first message no longer replace it. */
  titleSetByUser: boolean;
  acpSessionId: string | null;
  askMode: AskMode;
  /** YOLO: the app approves whatever the agent asks permission for, without asking the user. */
  bypassPermissions: boolean;
  status: ConversationStatus;
  statusDetail: string | null;
  openInTerminal: TerminalActivity | null;
  /** The agent's latest report of its context window; kept in memory only, so it is empty after a host restart until the next response. */
  contextUsage: ContextUsage | null;
  /** Messages the user sent while the agent was busy, oldest first; each goes out when the turn before it ends. Kept in memory only. */
  queuedMessages: QueuedMessage[];
  configOptions: SessionConfigOption[];
  createdAt: number;
  updatedAt: number;
}

export type ConversationEvent =
  | { type: "user-message"; text: string }
  | { type: "acp"; update: SessionUpdate }
  | { type: "permission"; permissionId: string; toolCall: ToolCallUpdate; options: PermissionOption[] }
  | { type: "permission-resolved"; permissionId: string; optionId: string | null }
  | { type: "turn-end"; stopReason: StopReason }
  | { type: "profile-changed"; profileName: string | null }
  | { type: "error"; message: string };

/** A harness session in a workspace directory, possibly started outside the app. */
export interface ExternalSession {
  sessionId: string;
  title: string | null;
  updatedAt: string | null;
  /** The conversation already driving this session in the app, if any. */
  conversationId: string | null;
}

export type AdoptMode = "continue" | "fork";

export interface StoredEvent {
  seq: number;
  at: number;
  event: ConversationEvent;
}

export interface AskOption {
  label: string;
  description?: string;
  html?: string;
}

export type CanvasItemStatus = "shown" | "waiting" | "answered" | "cancelled";

export interface CanvasAnswer {
  label: string;
  note?: string;
  deliveredAs: "tool-result" | "next-message";
}

export interface CanvasItem {
  id: string;
  conversationId: string;
  kind: "show" | "ask";
  title: string;
  html?: string;
  question?: string;
  options?: AskOption[];
  allowOther?: boolean;
  status: CanvasItemStatus;
  answer?: CanvasAnswer;
  createdAt: number;
}
