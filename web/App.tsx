import { useCallback, useEffect, useReducer, useState, type Dispatch } from "react";
import { launchLabel, type Conversation } from "../shared/model.ts";
import { focusPane, startConversationIn, startRenamingOpenConversation } from "./actions.ts";
import { CanvasPanel } from "./Canvas.tsx";
import { ChatPanel } from "./Chat.tsx";
import { connection, type ConnectionStatus } from "./connection.ts";
import { HintLayer } from "./Hint.tsx";
import { adjacentConversation, adjacentWorkspaceConversation, currentWorkspace, numberedConversation } from "./navigation.ts";
import { Palette, ShortcutHelp, type PaletteEntry } from "./Palette.tsx";
import { ProfilesDialog } from "./Profiles.tsx";
import { SessionsDialog } from "./Sessions.tsx";
import type { ShortcutCommand } from "./shortcuts.ts";
import { Sidebar } from "./Sidebar.tsx";
import { splitColumns, Splitter, useChatCanvasSplit } from "./Splitter.tsx";
import { initialStateFor, reducer, type AppAction, type AppState } from "./state.ts";
import { useShortcuts } from "./useShortcuts.ts";

const conversationFromHash = () => location.hash.match(/^#\/c\/(.+)$/)?.[1] ?? null;

function useConnectionStatus() {
  const [status, setStatus] = useState<ConnectionStatus>(connection.status);
  useEffect(() => connection.onStatus(setStatus), []);
  return status;
}

/** Most recently active first; the open conversation last, so Enter on an empty query switches away from it. */
function recentConversations(state: AppState): Conversation[] {
  const isSelected = (conversation: Conversation) => Number(conversation.id === state.selectedConversationId);
  return [...state.conversations].sort((a, b) => isSelected(a) - isSelected(b) || b.updatedAt - a.updatedAt);
}

function paletteEntries(state: AppState, dispatch: Dispatch<AppAction>, canvas: { visible: boolean; toggle: () => void }): PaletteEntry[] {
  const workspaceName = (workspaceId: string) => state.workspaces.find(({ id }) => id === workspaceId)?.name ?? "";
  const conversations = recentConversations(state).map(
    (conversation): PaletteEntry => ({
      id: `conversation-${conversation.id}`,
      label: conversation.title,
      detail: workspaceName(conversation.workspaceId),
      kind: "conversation",
      run: () => dispatch({ type: "select", conversationId: conversation.id }),
    }),
  );
  const current = currentWorkspace(state);
  const currentFirst = [...state.workspaces].sort((a, b) => Number(b.id === current?.id) - Number(a.id === current?.id));
  const workspaceActions = currentFirst.flatMap((workspace): PaletteEntry[] => [
    {
      id: `new-${workspace.id}`,
      label: `New conversation in ${workspace.name}`,
      detail: launchLabel(workspace.defaultLaunch, state.profiles),
      kind: "action",
      run: () => startConversationIn(workspace, dispatch),
    },
    {
      id: `continue-${workspace.id}`,
      label: `Continue a session in ${workspace.name}…`,
      kind: "action",
      run: () => dispatch({ type: "open-overlay", overlay: { kind: "sessions", workspaceId: workspace.id } }),
    },
  ]);
  const openConversationActions: PaletteEntry[] = state.open
    ? [
        { id: "rename", label: "Rename conversation…", kind: "action", run: startRenamingOpenConversation },
        { id: "toggle-canvas", label: canvas.visible ? "Hide canvas" : "Show canvas", kind: "action", run: canvas.toggle },
      ]
    : [];
  return [
    ...conversations,
    ...workspaceActions,
    ...openConversationActions,
    { id: "add-workspace", label: "Add workspace…", kind: "action", run: () => dispatch({ type: "open-overlay", overlay: { kind: "add-workspace" } }) },
    { id: "profiles", label: "Profiles…", kind: "action", run: () => dispatch({ type: "open-overlay", overlay: { kind: "profiles" } }) },
    { id: "help", label: "Keyboard shortcuts", kind: "action", run: () => dispatch({ type: "open-overlay", overlay: { kind: "help" } }) },
  ];
}

/** Dialogs take the keyboard; the inline add-workspace field does not, so shortcuts keep working if it is left open. */
const isModal = (state: AppState) => state.overlay !== null && state.overlay.kind !== "add-workspace";

/** Keys forwarded from a canvas page may navigate but never create anything: the page is agent-written. */
const createsSomething = (command: ShortcutCommand) => command.type === "new-conversation";

export function App() {
  const [state, dispatch] = useReducer(reducer, conversationFromHash(), initialStateFor);
  const status = useConnectionStatus();
  const [canvasVisible, setCanvasVisible] = useState(true);
  const [chatShare, setChatShare] = useChatCanvasSplit();
  const toggleCanvas = () => setCanvasVisible((visible) => !visible);

  const closeOverlay = useCallback(() => {
    dispatch({ type: "close-overlay" });
    requestAnimationFrame(() => {
      const focusWasDropped = document.activeElement === document.body || document.activeElement === null;
      const anotherDialogOpened = document.querySelector(".modal-backdrop") !== null;
      if (focusWasDropped && !anotherDialogOpened) focusPane("chat");
    });
  }, []);

  const select = (conversationId: string | null) => conversationId && dispatch({ type: "select", conversationId });

  useShortcuts((command, fromCanvas) => {
    if (fromCanvas && createsSomething(command)) return;
    if (isModal(state)) {
      if (command.type === "palette" && state.overlay?.kind === "palette") closeOverlay();
      return;
    }
    switch (command.type) {
      case "palette":
      case "help":
        return dispatch({ type: "open-overlay", overlay: { kind: command.type } });
      case "adjacent-conversation":
        return select(adjacentConversation(state, command.step));
      case "adjacent-workspace":
        return select(adjacentWorkspaceConversation(state, command.step));
      case "numbered-conversation":
        return select(numberedConversation(state, command.number));
      case "new-conversation": {
        const workspace = currentWorkspace(state);
        return workspace && startConversationIn(workspace, dispatch);
      }
      case "toggle-canvas":
        return toggleCanvas();
      case "focus":
        if (command.pane === "canvas") setCanvasVisible(true);
        return requestAnimationFrame(() => focusPane(command.pane));
    }
  });

  useEffect(() => {
    const unsubscribe = connection.onMessage((message) => dispatch({ type: "server", message }));
    connection.connect();
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (status === "open" && state.selectedConversationId) {
      connection.send({ type: "conversation.subscribe", conversationId: state.selectedConversationId });
    }
  }, [status, state.selectedConversationId]);

  useEffect(() => {
    const hash = state.selectedConversationId ? `#/c/${state.selectedConversationId}` : "";
    if (location.hash !== hash) history.replaceState(null, "", hash || location.pathname);
  }, [state.selectedConversationId]);

  if (status === "unauthorized") {
    return (
      <div className="gate">
        <h1>Not signed in</h1>
        <p>Open the link the host printed in your terminal (it ends with <code>/auth?token=…</code>).</p>
      </div>
    );
  }

  const conversation = state.conversations.find(({ id }) => id === state.selectedConversationId) ?? null;
  const showCanvas = canvasVisible && conversation !== null && state.open !== null;
  const overlay = state.overlay;
  const sessionsWorkspace = overlay?.kind === "sessions" ? state.workspaces.find(({ id }) => id === overlay.workspaceId) : undefined;
  return (
    <div className={`layout ${showCanvas ? "" : "canvas-hidden"}`} style={showCanvas ? { gridTemplateColumns: splitColumns(chatShare) } : undefined}>
      <Sidebar state={state} dispatch={dispatch} />
      <main className="chat-column">
        {status !== "open" && <div className="banner">{status === "connecting" ? "Connecting…" : "Connection lost, reconnecting…"}</div>}
        {conversation && state.open ? (
          <ChatPanel
            key={conversation.id}
            conversation={conversation}
            profiles={state.profiles}
            open={state.open}
            canvasVisible={canvasVisible}
            onToggleCanvas={toggleCanvas}
          />
        ) : (
          <div className="empty">
            <h2>No conversation selected</h2>
            <p>Add a workspace (a project directory) on the left, then start a conversation in it with Claude Code or opencode.</p>
          </div>
        )}
      </main>
      {showCanvas && <Splitter chatShare={chatShare} onChange={setChatShare} />}
      {showCanvas && (
        <CanvasPanel key={conversation!.id} items={state.open!.canvas} assetsOrigin={state.canvasAssetsOrigin} />
      )}
      <HintLayer />
      <div className="notices">
        {state.notices.map((notice) => (
          <div key={notice.id} className="notice" onClick={() => dispatch({ type: "dismiss-notice", id: notice.id })}>
            {notice.text}
          </div>
        ))}
      </div>
      {overlay?.kind === "palette" && (
        <Palette entries={paletteEntries(state, dispatch, { visible: canvasVisible, toggle: toggleCanvas })} onClose={closeOverlay} />
      )}
      {overlay?.kind === "help" && <ShortcutHelp onClose={closeOverlay} />}
      {overlay?.kind === "profiles" && <ProfilesDialog profiles={state.profiles} onClose={closeOverlay} />}
      {sessionsWorkspace && <SessionsDialog workspace={sessionsWorkspace} profiles={state.profiles} dispatch={dispatch} onClose={closeOverlay} />}
    </div>
  );
}
