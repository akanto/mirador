import type {
  PermissionOption,
  SessionConfigOption,
  SessionUpdate,
  StopReason,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import type { Review } from "./review.ts";
import type { TerminalLayout } from "./terminal-layout.ts";

export type HarnessId = "claude" | "opencode";

export const harnessLabels: Record<HarnessId, string> = {
  claude: "Claude Code",
  opencode: "opencode",
};

export const harnessIds = Object.keys(harnessLabels) as HarnessId[];

export type AskMode = "wait" | "next-message";

export const askModeLabels: Record<AskMode, string> = {
  wait: "Agent waits for my answer",
  "next-message": "My answer is sent as the next message",
};

/** How to launch an agent: extra environment and a command to run first. No profile means the host's own environment. */
/** Another machine's Mirador opened from this one, e.g. a server the agents keep working on while this computer sleeps. */
export interface Machine {
  id: string;
  name: string;
  origin: string;
  createdAt: number;
  /** Where this host shows the machine on this computer; null until it first does. */
  relayPort: number | null;
  /** This host has joined the machine and signs in there as one of its devices. */
  joined: boolean;
  /** To tell the machine apart in the rail. */
  color: Pastel | null;
}

/** What this host last heard from a joined machine: whether it answers, and what each conversation waiting for you there waits for. */
export interface MachineStatus {
  machineId: string;
  reachable: boolean;
  waiting: WaitingFor[];
}

/** A device that asked to join this machine, waiting for someone to approve it by typing the number it shows. */
export interface JoinRequest {
  id: string;
  name: string;
  /** The network address it asked from. */
  fromAddress: string;
  /** Who it is signed in to Tailscale as, when it asked through tailscale serve. */
  tailscaleUser: string | null;
  expiresAt: number;
}

/** Another browser or app that joined this machine with an invite; it signs in with a token of its own, which revoking it ends. */
export interface Device {
  id: string;
  name: string;
  joinedAt: number;
  /** When it last connected or left. */
  lastSeenAt: number;
}

/** Where a device reaches the host from: its address, and its Tailscale login when it comes through `tailscale serve`. */
export interface ClientAddress {
  fromAddress: string;
  tailscaleUser: string | null;
}

/** A joined device's connections to the host right now, and where the latest one comes from. */
export interface DeviceConnection extends ClientAddress {
  /** Pages of the app open on it; none while only the desktop or phone app listens in the background. */
  pages: number;
}

export interface ListedDevice extends Device {
  connection: DeviceConnection | null;
}

/** Where other devices reach a host, and where its canvas pages load their libraries from. */
export interface PublicAddress {
  origin: string;
  canvasOrigin: string;
}

/** How other devices reach a host, as it runs and as saved for its next start; the environment's settings can't be changed in Settings. */
export interface ReachabilitySettings {
  publicAddress: PublicAddress | null;
  savedPublicAddress: PublicAddress | null;
  publicAddressSetByEnvironment: boolean;
  /** Whether the host listens for other devices over HTTPS itself, and on which port. */
  network: boolean;
  savedNetwork: boolean;
  networkSetByEnvironment: boolean;
  networkPort: number;
  /** What is saved differs from what the host runs with. */
  restartNeeded: boolean;
  /** Of the certificate authority Mirador made for itself; invite links carry it so joining machines can pin it. */
  authorityFingerprint: string | null;
}

/** An entry of a conversation that holds the query, with the line around its first occurrence. */
export interface SearchHit {
  entryKey: string;
  at: number;
  snippet: { before: string; match: string; after: string };
}

/** Its newest hits first. */
export interface ConversationMatches {
  conversationId: string;
  matches: number;
  hits: SearchHit[];
}

/** A prompt the user sends often, with {{parameters}} filled in each time. */
export interface PromptTemplate {
  id: string;
  name: string;
  text: string;
  createdAt: number;
}

export interface Profile {
  id: string;
  name: string;
  /** Fixed once created: the profile's conversations keep running on this agent. */
  harness: HarnessId;
  environment: string;
  prelaunch: string;
  /** The agent's mode a conversation takes when it starts with the profile or moves to it; null leaves the agent's own. */
  mode: string | null;
  /** YOLO, taken like the mode. */
  bypassPermissions: boolean;
  /** Questions, taken like the mode. */
  askMode: AskMode;
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

export type Pastel = "rose" | "peach" | "butter" | "mint" | "teal" | "sky" | "lavender" | "lilac";

export const pastelLabels: Record<Pastel, string> = {
  rose: "Rose",
  peach: "Peach",
  butter: "Butter",
  mint: "Mint",
  teal: "Teal",
  sky: "Sky",
  lavender: "Lavender",
  lilac: "Lilac",
};

export const isPastel = (value: unknown): value is Pastel => typeof value === "string" && Object.hasOwn(pastelLabels, value);

/** How readily Claude Code puts things on the canvas: "often" adds guidance to its system prompt. */
export type CanvasUse = "as-needed" | "often";

export const canvasUseLabels: Record<CanvasUse, string> = { "as-needed": "As needed", often: "Often" };

export const isCanvasUse = (value: unknown): value is CanvasUse => typeof value === "string" && Object.hasOwn(canvasUseLabels, value);

export interface Workspace {
  id: string;
  name: string;
  path: string;
  defaultLaunch: Launch;
  /** Picked by the user to tell workspaces apart in the sidebar. */
  color: Pastel | null;
  /** Its place among the workspaces in the sidebar. */
  position: number;
  createdAt: number;
}

export interface QueuedMessage {
  id: string;
  text: string;
  imageIds: string[];
  /** Posted by a script the agent started (scripts/mirador-message) rather than typed by the user. */
  fromScript?: true;
  /** Waits for the running turn to end, then goes out as the next message, instead of joining the turn (⌥Enter). */
  afterTurn?: true;
}

export interface ContextUsage {
  used: number;
  size: number;
  cost: { amount: number; currency: string } | null;
}

/** How much of a plan usage limit's window is used, 0 to 100, and when the window starts over, in epoch milliseconds. */
export interface QuotaWindow {
  usedPercent: number;
  resetsAt: number;
}

/** The usage limits of a Claude subscription: the rolling five-hour window and the weekly one. */
export interface PlanQuotas {
  fiveHour: QuotaWindow | null;
  sevenDay: QuotaWindow | null;
}

/** The host's part of a conversation's statusline; the page adds what it already knows. */
export interface StatuslineRender {
  gitBranch: string | null;
  /** Claude Code's `statusLine` command from the conversation's Claude settings, when one is set. */
  command: string | null;
  /** What the command printed, ANSI colours and all; null when it was not run or did not succeed. */
  output: string | null;
  error: string | null;
  /** The plan's usage limits as the agent last reported them for the conversation's profile; null until it has. */
  quotas: PlanQuotas | null;
}

/** Why the agent waits for you: a tool to approve, a canvas question to answer, or a turn that ended (or failed) while you looked elsewhere. */
export type WaitingFor = "permission" | "question" | "finished" | "error";

/** While Claude's usage limit is reached, queued messages wait; the agent continues by itself at `continuesAt`, or only when told to (null). */
export interface UsageLimitWait {
  resetsAt: number | null;
  continuesAt: number | null;
}

/** A job an agent left running: a process, or a Docker or Podman container. */
export type WaitedJob = { kind: "process"; pid: number } | { kind: "container"; name: string };

/** Set up by `mirador when-done`: once the job ends, its message goes to the agent as your next message, or only to you. */
export interface JobWait {
  id: string;
  job: WaitedJob;
  /** The machine the job runs on, reached over ssh; null for this one. */
  sshHost: string | null;
  message: string;
  /** The agent gets the message and carries on; otherwise only you are told. */
  resume: boolean;
  since: number;
}

/** `gave-up`: the job could not be checked for too long, e.g. its machine stopped answering, so it may still run. */
export type JobWaitEnd = "ended" | "gave-up" | "stopped";

/** A tool the agent waits for permission to run, or the tool call it started last that has not finished, by its title. */
export interface Activity {
  kind: "permission" | "tool";
  title: string;
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
  /** Messages sent while the agent was busy, oldest first: each joins the running turn at the agent's next step, or waits for the turn to end. */
  queuedMessages: QueuedMessage[];
  usageLimit: UsageLimitWait | null;
  jobWaits: JobWait[];
  /** Kept in memory, except for questions, so a host restart forgets the turns that ended unseen. */
  waitingFor: WaitingFor | null;
  /** What the agent does now, while a turn runs; kept in memory only. */
  activity: Activity | null;
  configOptions: SessionConfigOption[];
  /** Its place among its workspace's conversations in the sidebar. */
  position: number;
  createdAt: number;
  updatedAt: number;
}

export type CommandStream = "stdout" | "stderr";

/** Shells side by side in one tab of a workspace's terminal pane; the title is what the first shell last set, if anything. */
export const MAX_TERMINALS_PER_TAB = 4;

export interface TabTerminal {
  id: string;
  title: string | null;
}

export interface TerminalTab {
  id: string;
  name: string;
  /** In reading order. */
  terminals: TabTerminal[];
  layout: TerminalLayout;
}

export type ConversationEvent =
  | { type: "user-message"; text: string; attachedCommandIds?: string[]; imageIds?: string[]; fromScript?: true }
  | { type: "user-command"; commandId: string; command: string }
  | { type: "user-command-output"; commandId: string; stream: CommandStream; text: string }
  | { type: "user-command-ended"; commandId: string; exitCode: number | null }
  | { type: "user-command-dropped"; commandIds: string[] }
  | { type: "acp"; update: SessionUpdate }
  | { type: "permission"; permissionId: string; toolCall: ToolCallUpdate; options: PermissionOption[] }
  | { type: "permission-resolved"; permissionId: string; optionId: string | null }
  | { type: "turn-end"; stopReason: StopReason }
  | { type: "profile-changed"; profileName: string | null }
  /** From here on the agent works in a fresh session, with nothing of the conversation before in its context. */
  | { type: "context-cleared" }
  /**
   * `usageLimit`: Claude's usage limit stopped the turn; it resets at `resetsAt`, when the message names a time.
   * `authRequired`: the agent refused the prompt until the user signs in again.
   */
  | { type: "error"; message: string; usageLimit?: { resetsAt: number | null }; authRequired?: true }
  /** The agent's sign-in, started from the conversation in a terminal tab, ended. */
  | { type: "login-ended"; signedIn: boolean }
  | { type: "usage-limit-wait-stopped" }
  | { type: "job-wait-ended"; wait: JobWait; end: JobWaitEnd };

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
  kind: "show" | "ask" | "review";
  title: string;
  html?: string;
  question?: string;
  options?: AskOption[];
  allowOther?: boolean;
  status: CanvasItemStatus;
  answer?: CanvasAnswer;
  /** Pages the agent showed since the user last wrote or answered, which a question carries so both are seen together. */
  shownBefore?: string[];
  review?: Review;
  createdAt: number;
  /** When the item last changed, so a client catching up after a reconnect gets only the items that changed since. */
  updatedAt?: number;
}
