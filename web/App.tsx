import { useCallback, useEffect, useReducer, useRef, useState, type CSSProperties, type Dispatch } from "react";
import { launchLabel, workspaceColorLabels, type CanvasItem, type Conversation } from "../shared/model.ts";
import { focusPane, startConversationIn, startRenamingOpenConversation } from "./actions.ts";
import { CanvasPanel } from "./Canvas.tsx";
import { ChatPanel } from "./Chat.tsx";
import { connection, type ConnectionStatus } from "./connection.ts";
import { HintLayer } from "./Hint.tsx";
import { hints } from "./hints.ts";
import { adjacentConversation, adjacentWorkspaceConversation, currentWorkspace, numberedConversation } from "./navigation.ts";
import { Palette, ShortcutHelp, type PaletteEntry } from "./Palette.tsx";
import { DEFAULT_SIDEBAR_WIDTH, type PaneLayout } from "./layout.ts";
import { useConversationLayouts, useSidebarWidth } from "./paneLayouts.ts";
import { ProfilesDialog } from "./Profiles.tsx";
import { isFreshReview } from "./review-placement.ts";
import { SessionsDialog } from "./Sessions.tsx";
import { SettingsDialog } from "./Settings.tsx";
import { shortcutKeys, type ShortcutCommand } from "./shortcuts.ts";
import { Sidebar } from "./Sidebar.tsx";
import { Splitter } from "./Splitter.tsx";
import { initialStateFor, reducer, type AppAction, type AppState } from "./state.ts";
import { useSystemNotifications } from "./system-notifications.ts";
import { TerminalPane } from "./Terminals.tsx";
import { useShortcuts } from "./useShortcuts.ts";
import { WorkspaceArea } from "./Workspace.tsx";

const conversationFromHash = () => location.hash.match(/^#\/c\/(.+)$/)?.[1] ?? null;

function useConnectionStatus() {
  const [status, setStatus] = useState<ConnectionStatus>(connection.status);
  useEffect(() => connection.onStatus(setStatus), []);
  return status;
}

const restartHost = () => connection.send({ type: "host.restart" });

/** A restarted host may speak a newer protocol and serves newer UI code, so the page loads again from it. */
function useReloadWhenHostRestarted(hostRunId: string | null) {
  const loadedFrom = useRef(hostRunId);
  useEffect(() => {
    loadedFrom.current ??= hostRunId;
    if (hostRunId !== loadedFrom.current) location.reload();
  }, [hostRunId]);
}

function HostBanner({ status, state }: { status: ConnectionStatus; state: AppState }) {
  if (state.hostRestarting) return <div className="banner">Restarting the host…</div>;
  if (status !== "open") return <div className="banner">{status === "connecting" ? "Connecting…" : "Connection lost, reconnecting…"}</div>;
  if (!state.hostCodeChanged) return null;
  return (
    <div className="banner host-code-changed">
      <span>The host's code changed since it started.</span>
      <button type="button" data-hint={hints.restartHost} onClick={restartHost}>
        Restart host <kbd>{shortcutKeys().restartHost}</kbd>
      </button>
    </div>
  );
}

/** Most recently active first; the open conversation last, so Enter on an empty query switches away from it. */
function recentConversations(state: AppState): Conversation[] {
  const isSelected = (conversation: Conversation) => Number(conversation.id === state.selectedConversationId);
  return [...state.conversations].sort((a, b) => isSelected(a) - isSelected(b) || b.updatedAt - a.updatedAt);
}

interface PaneToggle {
  visible: boolean;
  toggle: () => void;
}

function paletteEntries(state: AppState, dispatch: Dispatch<AppAction>, canvas: PaneToggle, terminal: PaneToggle, resetLayout: () => void): PaletteEntry[] {
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
    {
      id: `color-${workspace.id}`,
      label: `Colour ${workspace.name}…`,
      detail: workspace.color ? workspaceColorLabels[workspace.color] : "no colour",
      kind: "action",
      run: () => dispatch({ type: "open-overlay", overlay: { kind: "workspace-color", workspaceId: workspace.id } }),
    },
  ]);
  const openConversation = state.conversations.find(({ id }) => id === state.selectedConversationId);
  const openConversationActions: PaletteEntry[] =
    state.open && openConversation
      ? [
          { id: "rename", label: "Rename conversation…", kind: "action", run: startRenamingOpenConversation },
          { id: "toggle-canvas", label: canvas.visible ? "Hide canvas" : "Show canvas", kind: "action", run: canvas.toggle },
          { id: "toggle-terminal", label: terminal.visible ? "Hide terminal" : "Show terminal", kind: "action", run: terminal.toggle },
          { id: "reset-layout", label: "Reset layout to default", detail: openConversation.title, kind: "action", run: resetLayout },
        ]
      : [];
  return [
    ...conversations,
    ...workspaceActions,
    ...openConversationActions,
    { id: "add-workspace", label: "Add workspace…", kind: "action", run: () => dispatch({ type: "open-overlay", overlay: { kind: "add-workspace" } }) },
    { id: "profiles", label: "Profiles…", kind: "action", run: () => dispatch({ type: "open-overlay", overlay: { kind: "profiles" } }) },
    { id: "settings", label: "Settings…", kind: "action", run: () => dispatch({ type: "open-overlay", overlay: { kind: "settings" } }) },
    { id: "help", label: "Keyboard shortcuts", kind: "action", run: () => dispatch({ type: "open-overlay", overlay: { kind: "help" } }) },
    { id: "restart-host", label: "Restart the host", detail: "runs its code as it is now", kind: "action", run: restartHost },
  ];
}

/** Dialogs take the keyboard; the inline add-workspace field does not, so shortcuts keep working if it is left open. */
const isModal = (state: AppState) => state.overlay !== null && state.overlay.kind !== "add-workspace";

/** Keys forwarded from a canvas page may navigate but never create or restart anything: the page is agent-written. */
const changesSomething = (command: ShortcutCommand) => ["new-conversation", "new-workspace", "restart-host"].includes(command.type);

function useShowCanvasForNewReview(items: CanvasItem[] | undefined, canvasVisible: boolean, showCanvas: () => void) {
  const newestReview = items?.filter((item) => item.kind === "review").at(-1);
  useEffect(() => {
    if (!canvasVisible && isFreshReview(newestReview)) showCanvas();
  }, [newestReview?.id]);
}

export function App() {
  const [state, dispatch] = useReducer(reducer, conversationFromHash(), initialStateFor);
  const status = useConnectionStatus();
  useReloadWhenHostRestarted(state.hostRunId);
  const conversationLayouts = useConversationLayouts();
  const [sidebarWidth, setSidebarWidth] = useSidebarWidth();
  const workspace = currentWorkspace(state);
  const layout = conversationLayouts.layoutOf(state.selectedConversationId);
  const changeLayout = (update: (layout: PaneLayout) => PaneLayout) => conversationLayouts.change(state.selectedConversationId, update);
  const setHidden = (pane: "canvas" | "terminals", hidden: (wasHidden: boolean) => boolean) =>
    changeLayout((current) => ({ ...current, hidden: { ...current.hidden, [pane]: hidden(current.hidden[pane]) } }));
  const canvasVisible = !layout.hidden.canvas;
  const terminalVisible = !layout.hidden.terminals;
  const toggleCanvas = () => setHidden("canvas", (wasHidden) => !wasHidden);
  const toggleTerminal = () => setHidden("terminals", (wasHidden) => !wasHidden);

  useShowCanvasForNewReview(state.open?.canvas, canvasVisible, () => setHidden("canvas", () => false));

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
    if (fromCanvas && changesSomething(command)) return;
    if (command.type === "reload-page") return location.reload();
    if (command.type === "restart-host") return restartHost();
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
      case "new-workspace":
        dispatch({ type: "open-overlay", overlay: { kind: "add-workspace" } });
        return requestAnimationFrame(() => document.querySelector<HTMLInputElement>(".add-workspace input")?.focus());
      case "toggle-canvas":
        return toggleCanvas();
      case "focus":
        if (command.pane === "canvas") setHidden("canvas", () => false);
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

  const openConversation = useCallback((conversationId: string) => dispatch({ type: "select", conversationId }), []);
  useSystemNotifications(state.selectedConversationId, status === "open", openConversation);

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
  const terminalWorkspace = terminalVisible ? workspace : undefined;
  const overlay = state.overlay;
  const sessionsWorkspace = overlay?.kind === "sessions" ? state.workspaces.find(({ id }) => id === overlay.workspaceId) : undefined;
  const conversationPane = (
    <main className="chat-column">
      <HostBanner status={status} state={state} />
      {conversation && state.open ? (
        <ChatPanel
          key={conversation.id}
          conversation={conversation}
          profiles={state.profiles}
          promptTemplates={state.promptTemplates}
          onManageTemplates={() => dispatch({ type: "open-overlay", overlay: { kind: "settings", section: "prompt-templates" } })}
          open={state.open}
          canvasVisible={canvasVisible}
          onToggleCanvas={toggleCanvas}
          terminalVisible={terminalVisible}
          onToggleTerminal={toggleTerminal}
        />
      ) : (
        <div className="empty">
          <h2>No conversation selected</h2>
          <p>Add a workspace (a project directory) on the left, then start a conversation in it with Claude Code or opencode.</p>
        </div>
      )}
    </main>
  );
  return (
    <div className="layout" style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}>
      <Sidebar state={state} dispatch={dispatch} />
      <Splitter
        label="Resize the sidebar"
        share={sidebarWidth / window.innerWidth}
        resetShare={DEFAULT_SIDEBAR_WIDTH / window.innerWidth}
        minimumSize={0}
        area={() => ({ start: 0, size: window.innerWidth })}
        onChange={(share) => setSidebarWidth(share * window.innerWidth)}
      />
      <WorkspaceArea
        layout={layout}
        onChange={changeLayout}
        content={{
          conversation: conversationPane,
          canvas: showCanvas ? <CanvasPanel key={conversation!.id} items={state.open!.canvas} assetsOrigin={state.canvasAssetsOrigin} onHide={toggleCanvas} /> : null,
          terminals: terminalWorkspace ? <TerminalPane key={terminalWorkspace.id} workspace={terminalWorkspace} status={status} onHide={toggleTerminal} /> : null,
        }}
      />
      <HintLayer />
      <div className="notices">
        {state.notices.map((notice) => (
          <div key={notice.id} className="notice" onClick={() => dispatch({ type: "dismiss-notice", id: notice.id })}>
            {notice.text}
          </div>
        ))}
      </div>
      {overlay?.kind === "palette" && (
        <Palette
          entries={paletteEntries(
            state,
            dispatch,
            { visible: canvasVisible, toggle: toggleCanvas },
            { visible: terminalVisible, toggle: toggleTerminal },
            () => state.selectedConversationId && conversationLayouts.reset(state.selectedConversationId),
          )}
          onClose={closeOverlay}
        />
      )}
      {overlay?.kind === "help" && <ShortcutHelp onClose={closeOverlay} />}
      {overlay?.kind === "profiles" && <ProfilesDialog profiles={state.profiles} conversations={state.conversations} onClose={closeOverlay} />}
      {overlay?.kind === "settings" && (
        <SettingsDialog
          section={overlay.section}
          promptTemplates={state.promptTemplates}
          layoutDefault={conversationLayouts.layoutDefault}
          onChange={conversationLayouts.setLayoutDefault}
          onClose={closeOverlay}
        />
      )}
      {sessionsWorkspace && <SessionsDialog workspace={sessionsWorkspace} profiles={state.profiles} dispatch={dispatch} onClose={closeOverlay} />}
    </div>
  );
}
