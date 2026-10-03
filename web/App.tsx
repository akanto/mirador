import { Activity, memo, useCallback, useEffect, useReducer, useRef, useState, type CSSProperties, type Dispatch, type ReactNode } from "react";
import { launchLabel, workspaceColorLabels, type CanvasItem, type Conversation, type Machine } from "../shared/model.ts";
import { findInOpenConversation, focusPane, startConversationIn, startRenamingOpenConversation } from "./actions.ts";
import { CanvasPanel } from "./Canvas.tsx";
import { ChatPanel } from "./Chat.tsx";
import { connection, type ConnectionStatus } from "./connection.ts";
import { JoinMachine } from "./Devices.tsx";
import { JoinRequestPrompts } from "./JoinRequests.tsx";
import { MachineFrames, MachineRail, showsMachinesHere, useShownMachine } from "./MachineRail.tsx";
import { MachinesDialog, openMachine } from "./Machines.tsx";
import { HintLayer } from "./Hint.tsx";
import { SearchDialog } from "./Search.tsx";
import { hints } from "./hints.ts";
import { useLoginRequest } from "./login-request.ts";
import { adjacentConversation, adjacentWorkspaceConversation, currentWorkspace, numberedConversation } from "./navigation.ts";
import { Palette, ShortcutHelp, type PaletteEntry } from "./Palette.tsx";
import { DEFAULT_SIDEBAR_WIDTH, sidebarWidthWithinLimits, type PaneLayout } from "./layout.ts";
import { useConversationLayouts, useSidebarWidth } from "./paneLayouts.ts";
import { ProfilesDialog } from "./Profiles.tsx";
import { isFreshReview } from "./review-placement.ts";
import { SessionsDialog } from "./Sessions.tsx";
import { SettingsDialog } from "./Settings.tsx";
import { shortcutKeys, type ShortcutCommand } from "./shortcuts.ts";
import { Sidebar } from "./Sidebar.tsx";
import { Splitter } from "./Splitter.tsx";
import { initialStateFor, reducer, selectedOpen, type AppAction, type AppState, type OpenConversation } from "./state.ts";
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

function paletteEntries(
  state: AppState,
  dispatch: Dispatch<AppAction>,
  canvas: PaneToggle,
  terminal: PaneToggle,
  resetLayout: () => void,
  showMachine: (machine: Machine) => void,
): PaletteEntry[] {
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
    selectedOpen(state) && openConversation
      ? [
          { id: "rename", label: "Rename conversation…", kind: "action", run: startRenamingOpenConversation },
          { id: "toggle-canvas", label: canvas.visible ? "Hide canvas" : "Show canvas", kind: "action", run: canvas.toggle },
          { id: "toggle-terminal", label: terminal.visible ? "Hide terminal" : "Show terminal", kind: "action", run: terminal.toggle },
          { id: "reset-layout", label: "Reset layout to default", detail: openConversation.title, kind: "action", run: resetLayout },
        ]
      : [];
  const machineActions = state.machines.map(
    (machine): PaletteEntry => ({ id: `machine-${machine.id}`, label: `Open machine ${machine.name}`, detail: machine.origin, kind: "action", run: () => showMachine(machine) }),
  );
  return [
    ...conversations,
    ...workspaceActions,
    ...openConversationActions,
    ...machineActions,
    { id: "search", label: "Search all workspaces…", detail: "every conversation", kind: "action", run: () => dispatch({ type: "open-overlay", overlay: { kind: "search" } }) },
    { id: "add-workspace", label: "Add workspace…", kind: "action", run: () => dispatch({ type: "open-overlay", overlay: { kind: "add-workspace" } }) },
    { id: "profiles", label: "Profiles…", kind: "action", run: () => dispatch({ type: "open-overlay", overlay: { kind: "profiles" } }) },
    { id: "machines", label: "Machines…", kind: "action", run: () => dispatch({ type: "open-overlay", overlay: { kind: "machines" } }) },
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

/** Moving a drawn conversation within the page would lose its scroll position, so they keep one order whichever is selected. */
const inFixedOrder = (kept: OpenConversation[]) => kept.toSorted((a, b) => a.conversationId.localeCompare(b.conversationId));

/** React still redraws hidden content as its props change; a hidden conversation instead catches up on what its agent did in one go when shown. */
const RedrawnOnlyWhenShown = memo(
  ({ children }: { shown: boolean; children: ReactNode }) => children,
  (_, next) => !next.shown,
);

/** Subscribes to each conversation the page starts keeping, and to all of them again after a reconnect; unsubscribes from those it lets go. */
function useKeptConversationsSubscribed(status: ConnectionStatus, kept: OpenConversation[]) {
  const subscribed = useRef(new Set<string>());
  const keptIds = kept.map(({ conversationId }) => conversationId);
  useEffect(() => {
    if (status !== "open") {
      subscribed.current = new Set();
      return;
    }
    keptIds.filter((id) => !subscribed.current.has(id)).forEach((conversationId) => connection.send({ type: "conversation.subscribe", conversationId }));
    [...subscribed.current].filter((id) => !keptIds.includes(id)).forEach((conversationId) => connection.send({ type: "conversation.unsubscribe", conversationId }));
    subscribed.current = new Set(keptIds);
  }, [status, keptIds.join(" ")]);
}

export function App() {
  const [state, dispatchToState] = useReducer(reducer, conversationFromHash(), initialStateFor);
  const machines = useShownMachine(state.machines, state.hostRunId !== null);
  /** Whatever selects a conversation here, from the palette to a notification, brings this computer's own view back. */
  const dispatch = useCallback((action: AppAction) => {
    if (action.type === "select") machines.show(null);
    dispatchToState(action);
  }, []);
  const showMachine = (machine: Machine) => (showsMachinesHere() ? machines.show(machine.id) : openMachine(machine.origin));
  const railShown = showsMachinesHere() && state.machines.length > 0;
  const shownMachine = railShown ? machines.shown : null;
  const status = useConnectionStatus();
  useReloadWhenHostRestarted(state.hostRunId);
  const conversationLayouts = useConversationLayouts();
  const [sidebarWidth, setSidebarWidth] = useSidebarWidth();
  const layoutElement = useRef<HTMLDivElement>(null);
  const layoutArea = () => {
    const { left, width } = layoutElement.current!.getBoundingClientRect();
    return { start: left, size: width };
  };
  const showSidebarWidth = (share: number) =>
    layoutElement.current?.style.setProperty("--sidebar-width", `${sidebarWidthWithinLimits(share * layoutArea().size)}px`);
  const workspace = currentWorkspace(state);
  const layout = conversationLayouts.layoutOf(state.selectedConversationId);
  const changeLayout = (update: (layout: PaneLayout) => PaneLayout) => conversationLayouts.change(state.selectedConversationId, update);
  const setHidden = (pane: "canvas" | "terminals", hidden: (wasHidden: boolean) => boolean) =>
    changeLayout((current) => ({ ...current, hidden: { ...current.hidden, [pane]: hidden(current.hidden[pane]) } }));
  const canvasVisible = !layout.hidden.canvas;
  const terminalVisible = !layout.hidden.terminals;
  const toggleCanvas = () => setHidden("canvas", (wasHidden) => !wasHidden);
  const toggleTerminal = () => setHidden("terminals", (wasHidden) => !wasHidden);

  const open = selectedOpen(state);
  const loginRequest = useLoginRequest();
  useEffect(() => {
    if (loginRequest) setHidden("terminals", () => false);
  }, [loginRequest]);
  useShowCanvasForNewReview(open?.canvas, canvasVisible, () => setHidden("canvas", () => false));

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
    if (fromCanvas && (changesSomething(command) || command.type === "find")) return;
    if (command.type === "reload-page") return location.reload();
    if (command.type === "restart-host") return restartHost();
    if (isModal(state)) {
      if ((command.type === "palette" || command.type === "search") && state.overlay?.kind === command.type) closeOverlay();
      return;
    }
    switch (command.type) {
      case "palette":
      case "help":
      case "search":
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
      case "find":
        return findInOpenConversation();
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

  useKeptConversationsSubscribed(status, state.kept);

  const openConversation = useCallback(
    (conversationId: string, machineId?: string) => {
      const machine = state.machines.find(({ id }) => id === machineId);
      if (!machine) return dispatch({ type: "select", conversationId });
      if (showsMachinesHere()) return machines.openIn(machine.id, conversationId);
      openMachine(machine.origin, conversationId);
    },
    [state.machines],
  );
  useSystemNotifications(shownMachine ? null : state.selectedConversationId, status === "open", openConversation);

  useEffect(() => {
    const selectFromHash = () => {
      const conversationId = conversationFromHash();
      if (conversationId) dispatch({ type: "select", conversationId });
    };
    window.addEventListener("hashchange", selectFromHash);
    return () => window.removeEventListener("hashchange", selectFromHash);
  }, []);

  useEffect(() => {
    const hash = machines.shownId ? `#/m/${machines.shownId}` : state.selectedConversationId ? `#/c/${state.selectedConversationId}` : "";
    if (location.hash !== hash) history.replaceState(null, "", hash || location.pathname);
  }, [state.selectedConversationId, machines.shownId]);

  if (status === "unauthorized") return <JoinMachine />;

  const conversation = state.conversations.find(({ id }) => id === state.selectedConversationId) ?? null;
  const showCanvas = canvasVisible && conversation !== null && open !== null;
  const terminalWorkspace = terminalVisible ? workspace : undefined;
  const overlay = state.overlay;
  const sessionsWorkspace = overlay?.kind === "sessions" ? state.workspaces.find(({ id }) => id === overlay.workspaceId) : undefined;
  const conversationPane = (
    <main className="chat-column">
      <HostBanner status={status} state={state} />
      {inFixedOrder(state.kept).map((kept) => {
        const keptConversation = state.conversations.find(({ id }) => id === kept.conversationId);
        return (
          keptConversation && (
            <Activity key={kept.conversationId} mode={kept === open ? "visible" : "hidden"}>
              <RedrawnOnlyWhenShown shown={kept === open}>
                <ChatPanel
                  conversation={keptConversation}
                  profiles={state.profiles}
                  promptTemplates={state.promptTemplates}
                  onManageTemplates={() => dispatch({ type: "open-overlay", overlay: { kind: "settings", section: "prompt-templates" } })}
                  open={kept}
                  canvasVisible={canvasVisible}
                  onToggleCanvas={toggleCanvas}
                  terminalVisible={terminalVisible}
                  onToggleTerminal={toggleTerminal}
                />
              </RedrawnOnlyWhenShown>
            </Activity>
          )
        );
      })}
      {!(conversation && open) && (
        <div className="empty">
          <h2>No conversation selected</h2>
          <p>Add a workspace (a project directory) on the left, then start a conversation in it with Claude Code or opencode.</p>
        </div>
      )}
    </main>
  );
  const layoutWidth = layoutElement.current?.getBoundingClientRect().width ?? window.innerWidth;
  return (
    <div className={`app ${railShown ? "with-rail" : ""}`}>
      {railShown && (
        <MachineRail
          machines={state.machines}
          statuses={state.machineStatuses}
          shownId={shownMachine?.id ?? null}
          onShow={machines.show}
          onManage={() => dispatch({ type: "open-overlay", overlay: { kind: "machines" } })}
        />
      )}
      <div ref={layoutElement} className={`layout ${shownMachine ? "covered" : ""}`} style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}>
        <Sidebar state={state} dispatch={dispatch} />
        <Splitter
          label="Resize the sidebar"
          share={sidebarWidth / layoutWidth}
          resetShare={DEFAULT_SIDEBAR_WIDTH / layoutWidth}
          minimumSize={0}
          area={layoutArea}
          onDrag={showSidebarWidth}
          onChange={(share) => setSidebarWidth(share * layoutArea().size)}
        />
        <WorkspaceArea
          layout={layout}
          onChange={changeLayout}
          content={{
            conversation: conversationPane,
            canvas: showCanvas ? <CanvasPanel key={conversation!.id} items={open!.canvas} assetsOrigin={state.canvasAssetsOrigin} onHide={toggleCanvas} /> : null,
            terminals: terminalWorkspace ? <TerminalPane key={terminalWorkspace.id} workspace={terminalWorkspace} status={status} onHide={toggleTerminal} /> : null,
          }}
        />
      </div>
      {railShown && <MachineFrames machines={state.machines} shownId={shownMachine?.id ?? null} visited={machines.visited} opening={machines.opening} />}
      <HintLayer />
      <JoinRequestPrompts joinRequests={state.joinRequests} />
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
            showMachine,
          )}
          onClose={closeOverlay}
        />
      )}
      {overlay?.kind === "help" && <ShortcutHelp onClose={closeOverlay} />}
      {overlay?.kind === "search" && (
        <SearchDialog workspaces={state.workspaces} conversations={state.conversations} onOpen={(conversationId) => select(conversationId)} onClose={closeOverlay} />
      )}
      {overlay?.kind === "profiles" && <ProfilesDialog profiles={state.profiles} conversations={state.conversations} onClose={closeOverlay} />}
      {overlay?.kind === "machines" && (
        <MachinesDialog
          machines={state.machines}
          onOpen={(machine) => {
            closeOverlay();
            showMachine(machine);
          }}
          onClose={closeOverlay}
        />
      )}
      {overlay?.kind === "settings" && (
        <SettingsDialog
          section={overlay.section}
          promptTemplates={state.promptTemplates}
          canvasUse={state.canvasUse}
          layoutDefault={conversationLayouts.layoutDefault}
          onChange={conversationLayouts.setLayoutDefault}
          onClose={closeOverlay}
        />
      )}
      {sessionsWorkspace && <SessionsDialog workspace={sessionsWorkspace} profiles={state.profiles} dispatch={dispatch} onClose={closeOverlay} />}
    </div>
  );
}
