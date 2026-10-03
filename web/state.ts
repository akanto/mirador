import type { CanvasItem, CanvasUse, Conversation, Machine, MachineStatus, Profile, PromptTemplate, StoredEvent, Workspace } from "../shared/model.ts";
import type { ServerMessage } from "../shared/protocol.ts";
import { inSidebarOrder } from "../shared/sidebar-order.ts";

export interface OpenConversation {
  conversationId: string;
  loaded: boolean;
  events: StoredEvent[];
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
  | { kind: "settings"; section?: SettingsSection };

/** A part of Settings to open at, rather than at the top. */
export type SettingsSection = "prompt-templates";

export interface AppState {
  workspaces: Workspace[];
  conversations: Conversation[];
  profiles: Profile[];
  promptTemplates: PromptTemplate[];
  canvasUse: CanvasUse;
  canvasAssetsOrigin: string;
  machines: Machine[];
  machineStatuses: MachineStatus[];
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
  canvasAssetsOrigin: "",
  machines: [],
  machineStatuses: [],
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
  const opened = state.kept.find((open) => open.conversationId === conversationId) ?? { conversationId, loaded: false, events: [], canvas: [] };
  const others = state.kept.filter((open) => open !== opened);
  return { ...state, selectedConversationId: conversationId, kept: [opened, ...others].slice(0, KEPT_CONVERSATIONS) };
}

function withOpen(state: AppState, conversationId: string, change: (open: OpenConversation) => OpenConversation) {
  return state.kept.some((open) => open.conversationId === conversationId)
    ? { ...state, kept: state.kept.map((open) => (open.conversationId === conversationId ? change(open) : open)) }
    : state;
}

let noticeCounter = 0;

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
        canvasAssetsOrigin: message.canvasAssetsOrigin,
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
        canvas: message.canvas,
      }));
    case "conversation.event":
      return withOpen(state, message.conversationId, (open) => {
        const lastSeq = open.events.at(-1)?.seq ?? 0;
        return message.event.seq <= lastSeq ? open : { ...open, events: [...open.events, message.event] };
      });
    case "canvas.upserted":
      return withOpen(state, message.item.conversationId, (open) => ({ ...open, canvas: upsert(open.canvas, message.item) }));
    case "profile.upserted":
      return { ...state, profiles: upsert(state.profiles, message.profile).sort((a, b) => a.name.localeCompare(b.name)) };
    case "profile.deleted":
      return { ...state, profiles: state.profiles.filter(({ id }) => id !== message.profileId) };
    case "prompt-template.upserted":
      return { ...state, promptTemplates: upsert(state.promptTemplates, message.template).sort((a, b) => a.name.localeCompare(b.name)) };
    case "settings.canvas-use":
      return { ...state, canvasUse: message.canvasUse };
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
    case "statusline.rendered":
    case "terminals.listed":
    case "terminal.opened":
    case "terminal.replayed":
    case "terminal.output":
    case "terminal.exited":
    case "terminal.cleared":
    case "system-notification":
    case "devices.listed":
    case "devices.invited":
    case "search.results":
      return state;
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
