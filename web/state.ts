import type { CanvasItem, CanvasUse, ClaudeProgram, Conversation, HarnessId, JoinRequest, Machine, MachineStatus, Profile, PromptTemplate, StoredEvent, Workspace } from "../shared/model.ts";
import type { ServerMessage } from "../shared/protocol.ts";
import type { Turn } from "../shared/reverts.ts";
import { inSidebarOrder } from "../shared/sidebar-order.ts";

export interface OpenConversation {
  conversationId: string;
  loaded: boolean;
  /** The newest part of the history at first; earlier parts come as the reader scrolls up to them. */
  events: StoredEvent[];
  /** The host holds events before these. */
  hasEarlier: boolean;
  canvas: CanvasItem[];
}

export type Overlay =
  | { kind: "palette" }
  | { kind: "help" }
  | { kind: "search" }
  | { kind: "profiles" }
  | { kind: "machines" }
  | { kind: "sessions"; workspaceId: string }
  | { kind: "workspace-color"; workspaceId: string }
  | { kind: "add-workspace" }
  /** `rewind` takes the conversation and the files back; without it only the files are put back. */
  | { kind: "revert"; conversationId: string; turn: Turn; rewind?: boolean }
  | { kind: "settings"; page?: SettingsPage };

/** A part of Settings to open at, rather than at the top. */
export type SettingsPage = "appearance" | "conversations" | "agents" | "terminal" | "canvas" | "layout" | "devices" | "notifications" | "about";

export type DevicesListed = Extract<ServerMessage, { type: "devices.listed" }>;

export interface AppState {
  workspaces: Workspace[];
  conversations: Conversation[];
  profiles: Profile[];
  promptTemplates: PromptTemplate[];
  canvasUse: CanvasUse;
  claudeProgram: ClaudeProgram;
  /** The agents the host's machine has a program for, which a new profile can run. */
  installedAgents: HarnessId[];
  /** The version of the host serving this page. */
  version: string;
  canvasAssetsOrigin: string;
  agentsCanvasAssetsOrigin: string;
  machines: Machine[];
  machineStatuses: MachineStatus[];
  /** Devices asking to join this host, for this page to approve. */
  joinRequests: JoinRequest[];
  /** The devices that joined this host, who is connected now, and how other devices reach it. */
  devices: DevicesListed | null;
  homeDir: string;
  selectedConversationId: string | null;
  /** The conversations opened last, the selected one first: they stay subscribed and drawn, so switching back is instant. */
  kept: OpenConversation[];
  awaitingConversationIn: string | null;
  overlay: Overlay | null;
  notices: { id: number; text: string }[];
  /** The host process run this page last heard from; another one means the host restarted, maybe with new code. */
  hostRunId: string | null;
  hostCodeChanged: boolean;
  hostRestarting: boolean;
}

export type AppAction =
  | { type: "server"; message: ServerMessage }
  | { type: "select"; conversationId: string | null }
  | { type: "awaiting-conversation"; workspaceId: string }
  | { type: "open-overlay"; overlay: Overlay }
  | { type: "close-overlay" }
  | { type: "dismiss-notice"; id: number };

export const initialState: AppState = {
  workspaces: [],
  conversations: [],
  profiles: [],
  promptTemplates: [],
  canvasUse: "often",
  claudeProgram: { configured: "", found: null, version: null },
  installedAgents: [],
  version: "",
  canvasAssetsOrigin: "",
  agentsCanvasAssetsOrigin: "",
  machines: [],
  machineStatuses: [],
  joinRequests: [],
  devices: null,
  homeDir: "",
  selectedConversationId: null,
  kept: [],
  awaitingConversationIn: null,
  overlay: null,
  hostRunId: null,
  hostCodeChanged: false,
  hostRestarting: false,
  notices: [],
};

export function initialStateFor(conversationId: string | null): AppState {
  return select(initialState, conversationId);
}

function upsert<T extends { id: string }>(items: T[], item: T) {
  return items.some((existing) => existing.id === item.id)
    ? items.map((existing) => (existing.id === item.id ? item : existing))
    : [...items, item];
}

export const KEPT_CONVERSATIONS = 5;

export const selectedOpen = (state: AppState) => state.kept.find(({ conversationId }) => conversationId === state.selectedConversationId) ?? null;

function select(state: AppState, conversationId: string | null): AppState {
  if (conversationId === null) return { ...state, selectedConversationId: null };
  const opened = state.kept.find((open) => open.conversationId === conversationId) ?? { conversationId, loaded: false, events: [], hasEarlier: false, canvas: [] };
  const others = state.kept.filter((open) => open !== opened);
  return { ...state, selectedConversationId: conversationId, kept: [opened, ...others].slice(0, KEPT_CONVERSATIONS) };
}

function withOpen(state: AppState, conversationId: string, change: (open: OpenConversation) => OpenConversation) {
  return state.kept.some((open) => open.conversationId === conversationId)
    ? { ...state, kept: state.kept.map((open) => (open.conversationId === conversationId ? change(open) : open)) }
    : state;
}

let noticeCounter = 0;

/** Agents write the canvas library address they were given into their pages; this page may load them from another one. */
function withThisPagesAssetsOrigin(state: AppState, item: CanvasItem): CanvasItem {
  const { agentsCanvasAssetsOrigin: written, canvasAssetsOrigin: reachable } = state;
  return !written || written === reachable ? item : (JSON.parse(JSON.stringify(item).replaceAll(written, reachable)) as CanvasItem);
}

function applyServerMessage(state: AppState, message: ServerMessage): AppState {
  switch (message.type) {
    case "snapshot": {
      const exists = (conversationId: string | null) => message.conversations.some(({ id }) => id === conversationId);
      const next = {
        ...state,
        workspaces: [...message.workspaces].sort(inSidebarOrder),
        conversations: message.conversations,
        profiles: message.profiles,
        promptTemplates: message.promptTemplates,
        canvasUse: message.canvasUse,
        claudeProgram: message.claudeProgram,
        installedAgents: message.installedAgents,
        version: message.version,
        canvasAssetsOrigin: message.canvasAssetsOrigin,
        agentsCanvasAssetsOrigin: message.agentsCanvasAssetsOrigin,
        machines: message.machines,
        machineStatuses: message.machineStatuses,
        homeDir: message.homeDir,
        hostRunId: message.hostRunId,
        hostCodeChanged: message.hostCodeChanged,
        kept: state.kept.filter(({ conversationId }) => exists(conversationId)),
      };
      return exists(state.selectedConversationId) ? next : select(next, null);
    }
    case "workspace.upserted":
      return { ...state, workspaces: upsert(state.workspaces, message.workspace).sort(inSidebarOrder) };
    case "workspace.deleted":
      return { ...state, workspaces: state.workspaces.filter(({ id }) => id !== message.workspaceId) };
    case "conversation.upserted": {
      const isNew = !state.conversations.some(({ id }) => id === message.conversation.id);
      const next = { ...state, conversations: upsert(state.conversations, message.conversation) };
      if (isNew && state.awaitingConversationIn === message.conversation.workspaceId) {
        return select({ ...next, awaitingConversationIn: null }, message.conversation.id);
      }
      return next;
    }
    case "conversation.deleted": {
      const next = {
        ...state,
        conversations: state.conversations.filter(({ id }) => id !== message.conversationId),
        kept: state.kept.filter(({ conversationId }) => conversationId !== message.conversationId),
      };
      return state.selectedConversationId === message.conversationId ? select(next, null) : next;
    }
    case "conversation.history":
      return withOpen(state, message.conversationId, () => ({
        conversationId: message.conversationId,
        loaded: true,
        events: message.events,
        hasEarlier: message.hasEarlier ?? false,
        canvas: message.canvas.map((item) => withThisPagesAssetsOrigin(state, item)),
      }));
    case "conversation.earlier":
      return withOpen(state, message.conversationId, (open) =>
        open.events[0]?.seq === message.beforeSeq ? { ...open, events: [...message.events, ...open.events], hasEarlier: message.hasEarlier } : open,
      );
    case "conversation.event":
      return withOpen(state, message.conversationId, (open) => {
        const lastSeq = open.events.at(-1)?.seq ?? 0;
        return message.event.seq <= lastSeq ? open : { ...open, events: [...open.events, message.event] };
      });
    case "conversation.rewound":
    case "conversation.rewind-done":
      return withOpen(state, message.conversationId, (open) => ({ ...open, events: open.events.filter(({ seq }) => seq < message.fromSeq) }));
    case "canvas.upserted":
      return withOpen(state, message.item.conversationId, (open) => ({ ...open, canvas: upsert(open.canvas, withThisPagesAssetsOrigin(state, message.item)) }));
    case "profile.upserted":
      return { ...state, profiles: upsert(state.profiles, message.profile).sort((a, b) => a.name.localeCompare(b.name)) };
    case "profile.deleted":
      return { ...state, profiles: state.profiles.filter(({ id }) => id !== message.profileId) };
    case "prompt-template.upserted":
      return { ...state, promptTemplates: upsert(state.promptTemplates, message.template).sort((a, b) => a.name.localeCompare(b.name)) };
    case "settings.canvas-use":
      return { ...state, canvasUse: message.canvasUse };
    case "settings.claude-program":
      return { ...state, claudeProgram: message.claudeProgram };
    case "prompt-template.deleted":
      return { ...state, promptTemplates: state.promptTemplates.filter(({ id }) => id !== message.templateId) };
    case "error":
      return { ...state, notices: [...state.notices, { id: ++noticeCounter, text: message.message }] };
    case "fs.completions":
    case "profile.saved":
    case "sessions.listed":
    case "sessions.failed":
    case "review.file-read":
    case "review.file-failed":
    case "slash-commands.listed":
    case "prompt-history.listed":
    case "mentions.suggested":
    case "tool-output.got":
    case "tool-raw-output.got":
    case "conversation.found":
    case "statusline.rendered":
    case "terminals.listed":
    case "terminal.opened":
    case "terminal.replayed":
    case "terminal.output":
    case "terminal.exited":
    case "terminal.cleared":
    case "terminal.busy":
    case "system-notification":
    case "devices.invited":
    case "address.found":
    case "search.results":
    case "machine.join-asked":
    case "machine.join-answered":
    case "settings.saved":
    case "conversation.revert-previewed":
    case "conversation.reverted":
    case "conversation.revert-failed":
    case "conversation.rewind-previewed":
    case "conversation.rewind-failed":
      return state;
    case "join-request.answered":
      return message.problem ? { ...state, notices: [...state.notices, { id: ++noticeCounter, text: message.problem }] } : state;
    case "join-requests.listed":
      return { ...state, joinRequests: message.joinRequests };
    case "devices.listed":
      return { ...state, devices: message };
    case "machines.changed":
      return { ...state, machines: message.machines };
    case "machine.status":
      return { ...state, machineStatuses: [...state.machineStatuses.filter(({ machineId }) => machineId !== message.status.machineId), message.status] };
    case "host.code-changed":
      return { ...state, hostCodeChanged: true };
    case "host.restarting":
      return { ...state, hostRestarting: true };
  }
}

export function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "server":
      return applyServerMessage(state, action.message);
    case "select":
      return action.conversationId === state.selectedConversationId ? state : select(state, action.conversationId);
    case "awaiting-conversation":
      return { ...state, awaitingConversationIn: action.workspaceId };
    case "open-overlay":
      return { ...state, overlay: action.overlay };
    case "close-overlay":
      return { ...state, overlay: null };
    case "dismiss-notice":
      return { ...state, notices: state.notices.filter(({ id }) => id !== action.id) };
  }
}
