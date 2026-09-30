import type { CanvasItem, Conversation, Profile, StoredEvent, Workspace } from "../shared/model.ts";
import type { ServerMessage } from "../shared/protocol.ts";

export interface OpenConversation {
  conversationId: string;
  loaded: boolean;
  events: StoredEvent[];
  canvas: CanvasItem[];
}

export type Overlay =
  | { kind: "palette" }
  | { kind: "help" }
  | { kind: "profiles" }
  | { kind: "sessions"; workspaceId: string }
  | { kind: "add-workspace" };

export interface AppState {
  workspaces: Workspace[];
  conversations: Conversation[];
  profiles: Profile[];
  canvasAssetsOrigin: string;
  homeDir: string;
  selectedConversationId: string | null;
  open: OpenConversation | null;
  awaitingConversationIn: string | null;
  overlay: Overlay | null;
  notices: { id: number; text: string }[];
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
  canvasAssetsOrigin: "",
  homeDir: "",
  selectedConversationId: null,
  open: null,
  awaitingConversationIn: null,
  overlay: null,
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

function select(state: AppState, conversationId: string | null): AppState {
  return {
    ...state,
    selectedConversationId: conversationId,
    open: conversationId ? { conversationId, loaded: false, events: [], canvas: [] } : null,
  };
}

function withOpen(state: AppState, conversationId: string, change: (open: OpenConversation) => OpenConversation) {
  return state.open?.conversationId === conversationId ? { ...state, open: change(state.open) } : state;
}

let noticeCounter = 0;

function applyServerMessage(state: AppState, message: ServerMessage): AppState {
  switch (message.type) {
    case "snapshot": {
      const selectionStillExists = message.conversations.some(({ id }) => id === state.selectedConversationId);
      const next = {
        ...state,
        workspaces: message.workspaces,
        conversations: message.conversations,
        profiles: message.profiles,
        canvasAssetsOrigin: message.canvasAssetsOrigin,
        homeDir: message.homeDir,
      };
      return selectionStillExists ? next : select(next, null);
    }
    case "workspace.upserted":
      return { ...state, workspaces: upsert(state.workspaces, message.workspace) };
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
      const next = { ...state, conversations: state.conversations.filter(({ id }) => id !== message.conversationId) };
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
    case "error":
      return { ...state, notices: [...state.notices, { id: ++noticeCounter, text: message.message }] };
    case "fs.completions":
    case "profile.saved":
    case "sessions.listed":
    case "sessions.failed":
      return state;
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
