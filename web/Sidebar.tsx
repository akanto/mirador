import { useCallback, useEffect, useRef, useState, type Dispatch, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { connectedDevicesLabel, otherConnectedDevices } from "../shared/devices.ts";
import {
  launchLabel,
  terminalActivityLabels,
  type Conversation,
  type Profile,
  type WaitingFor,
  type Workspace,
  type Pastel,
} from "../shared/model.ts";
import { ColorSwatches } from "./ColorSwatches.tsx";
import { ConfirmButton } from "./ConfirmButton.tsx";
import { useConnectedDevicesInSidebar } from "./connected-devices.ts";
import { connection } from "./connection.ts";
import { ConversationTitle } from "./ConversationTitle.tsx";
import { DesktopMenu } from "./DesktopMenu.tsx";
import { useDragToReorder } from "./drag-to-reorder.ts";
import { startConversationIn } from "./actions.ts";
import { hints, statusHints, waitingHints } from "./hints.ts";
import { conversationsIn } from "./navigation.ts";
import { pastelVariables } from "./pastels.ts";
import { shortcutKeys } from "./shortcuts.ts";
import type { AppAction, AppState, DevicesListed, Overlay } from "./state.ts";
import { useTypingAidAttributes } from "./typing-aids.ts";
import { waitingByUrgency, waitingLabels, waitingTones } from "./waiting.ts";
import { parentFolder } from "./workspace-folder.ts";

function useDirectoryCompletions(prefix: string) {
  const [completions, setCompletions] = useState<string[]>([]);
  const latestRequest = useRef("");
  useEffect(
    () =>
      connection.onMessage((message) => {
        if (message.type === "fs.completions" && message.requestId === latestRequest.current) setCompletions(message.directories);
      }),
    [],
  );
  useEffect(() => {
    const requestId = crypto.randomUUID();
    latestRequest.current = requestId;
    connection.send({ type: "fs.complete", requestId, prefix });
  }, [prefix]);
  return completions;
}

function AddWorkspace({ onDone }: { onDone: () => void }) {
  const [path, setPath] = useState("~/");
  const typingAidAttributes = useTypingAidAttributes();
  const completions = useDirectoryCompletions(path);
  const [highlighted, setHighlighted] = useState(0);
  useEffect(() => setHighlighted(0), [completions]);

  const submit = () => {
    connection.send({ type: "workspace.create", path });
    onDone();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const highlightedCompletion = completions[highlighted];
    if (event.key === "Tab" && highlightedCompletion) {
      event.preventDefault();
      setPath(highlightedCompletion);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlighted((index) => Math.min(index + 1, completions.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlighted((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      submit();
    } else if (event.key === "Escape") {
      onDone();
    }
  };

  return (
    <div className="add-workspace">
      <input
        {...typingAidAttributes}
        autoFocus
        value={path}
        spellCheck={false}
        aria-label="Workspace directory"
        onChange={(event) => setPath(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="hint">Tab completes, Enter adds, Esc cancels</div>
      <ul className="completions">
        {completions.map((completion, index) => (
          <li key={completion} className={index === highlighted ? "highlighted" : ""} onMouseDown={() => setPath(completion)}>
            {completion}
          </li>
        ))}
      </ul>
    </div>
  );
}

function statusDot(conversation: Conversation) {
  const { waitingFor } = conversation;
  if (waitingFor) return <span className={`dot waiting tone-${waitingTones[waitingFor]}`} data-hint={waitingHints[waitingFor]} />;
  const inTerminal = conversation.openInTerminal;
  if (inTerminal && conversation.status === "idle") {
    return <span className={`dot terminal-${inTerminal}`} data-hint={`Open in a terminal: ${terminalActivityLabels[inTerminal]}`} />;
  }
  return <span className={`dot status-${conversation.status}`} data-hint={conversation.statusDetail ?? statusHints[conversation.status]} />;
}

function WaitingPill({ waitingFor }: { waitingFor: WaitingFor }) {
  const tone = waitingTones[waitingFor];
  return (
    <span className={`waiting-pill tone-${tone}`} data-hint={waitingHints[waitingFor]}>
      {waitingLabels[tone]}
    </span>
  );
}

function WaitingCount({ conversations }: { conversations: Conversation[] }) {
  const waiting = waitingByUrgency(conversations);
  if (waiting.length === 0) return null;
  return (
    <span className={`waiting-count tone-${waitingTones[waiting[0]!.waitingFor!]}`} data-hint={hints.waitingCount}>
      {waiting.length}
    </span>
  );
}

/** Every conversation waiting for you, across the workspaces; the stylesheet shows it only when chosen in Settings. */
function WaitingList({ state, dispatch }: { state: AppState; dispatch: Dispatch<AppAction> }) {
  const waiting = waitingByUrgency(state.workspaces.flatMap((workspace) => conversationsIn(state, workspace.id)));
  if (waiting.length === 0) return null;
  const workspaceName = (workspaceId: string) => state.workspaces.find(({ id }) => id === workspaceId)?.name ?? "";
  return (
    <section className="waiting-list" aria-label="Waiting for you">
      <h2>Waiting for you · {waiting.length}</h2>
      <ul>
        {waiting.map((conversation) => (
          <li
            key={conversation.id}
            className={conversation.id === state.selectedConversationId ? "selected" : ""}
            onClick={() => dispatch({ type: "select", conversationId: conversation.id })}
          >
            {statusDot(conversation)}
            <span className="waiting-title">{conversation.title}</span>
            <span className="waiting-workspace">{workspaceName(conversation.workspaceId)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const rowClasses = (conversation: Conversation, selectedConversationId: string | null) =>
  [conversation.id === selectedConversationId && "selected", conversation.waitingFor && "waiting"].filter(Boolean);

const markColors = ["#6e56cf", "#0e9384", "#d9822b", "#3e63dd", "#d6409f", "#12a594", "#8e4ec6", "#ad7f58"];

function initialsOf(name: string) {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const initials = words.length > 1 ? words.slice(0, 2).map((word) => word.charAt(0)).join("") : name.slice(0, 2);
  return initials.toUpperCase();
}

function markColorOf(name: string) {
  const hash = [...name].reduce((sum, character) => (sum * 31 + character.charCodeAt(0)) >>> 0, 7);
  return markColors[hash % markColors.length];
}

/**
 * A chip as wide as the chosen profile's name, with the select laid invisibly over it to open the choices. With no
 * profile yet, it leads to setting one up, which the main pane offers when no conversation is open.
 */
function LaunchPicker({ workspace, profiles, dispatch }: { workspace: Workspace; profiles: Profile[]; dispatch: Dispatch<AppAction> }) {
  if (profiles.length === 0) {
    return (
      <button className="link" data-hint={hints.setUpProfile} onClick={() => dispatch({ type: "select", conversationId: null })}>
        Set up a profile
      </button>
    );
  }
  const choose = (profileId: string) => {
    const profile = profiles.find(({ id }) => id === profileId);
    if (profile) connection.send({ type: "workspace.set-default-launch", workspaceId: workspace.id, launch: { harness: profile.harness, profileId } });
  };
  return (
    <span className="agent-chip">
      <span className="agent-chip-label">{launchLabel(workspace.defaultLaunch, profiles)}</span>
      <select aria-label="Agent" data-hint={hints.launch} value={workspace.defaultLaunch.profileId ?? ""} onChange={(event) => choose(event.target.value)}>
        {profiles.map(({ id, harness }) => (
          <option key={id} value={id}>
            {launchLabel({ harness, profileId: id }, profiles)}
          </option>
        ))}
      </select>
    </span>
  );
}

function WorkspaceColorPicker({ workspace, mark, onClose }: { workspace: Workspace; mark: RefObject<HTMLElement | null>; onClose: () => void }) {
  const picker = useRef<HTMLDivElement>(null);
  useEffect(() => {
    picker.current?.scrollIntoView({ block: "nearest" });
  }, []);
  useEffect(() => {
    const isOutside = (target: EventTarget | null) => ![picker.current, mark.current].some((element) => element?.contains(target as Node));
    const closeOnEscape = (event: globalThis.KeyboardEvent) => event.key === "Escape" && onClose();
    const closeOnPressElsewhere = (event: MouseEvent) => isOutside(event.target) && onClose();
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("mousedown", closeOnPressElsewhere);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("mousedown", closeOnPressElsewhere);
    };
  }, [onClose]);
  const choose = (color: Pastel | null) => {
    connection.send({ type: "workspace.set-color", workspaceId: workspace.id, color });
    onClose();
  };
  return (
    <div className="workspace-color-picker" ref={picker}>
      <ColorSwatches label={`Colour of ${workspace.name}`} chosen={workspace.color} onChoose={choose} />
    </div>
  );
}

function WorkspaceSection({
  workspace,
  conversations,
  profiles,
  homeDir,
  selectedConversationId,
  pickingColor,
  dispatch,
  dragClasses,
  onStartDrag,
}: {
  workspace: Workspace;
  conversations: Conversation[];
  profiles: Profile[];
  homeDir: string;
  selectedConversationId: string | null;
  pickingColor: boolean;
  dispatch: Dispatch<AppAction>;
  dragClasses: string[];
  onStartDrag: (event: PointerEvent<HTMLElement>) => void;
}) {
  const mark = useRef<HTMLButtonElement>(null);
  const closePicker = useCallback(() => dispatch({ type: "close-overlay" }), [dispatch]);
  const togglePicker = () => dispatch(pickingColor ? { type: "close-overlay" } : { type: "open-overlay", overlay: { kind: "workspace-color", workspaceId: workspace.id } });
  const deleteWorkspace = () => connection.send({ type: "workspace.delete", workspaceId: workspace.id });
  const deleteConversation = (conversation: Conversation) => connection.send({ type: "conversation.delete", conversationId: conversation.id });
  const conversationList = useRef<HTMLUListElement>(null);
  const conversationDrag = useDragToReorder((conversationId, beforeConversationId) =>
    connection.send({ type: "conversation.move", conversationId, beforeConversationId }),
  );

  return (
    <section
      className={["workspace", ...dragClasses].join(" ")}
      aria-label={workspace.name}
      data-reorder-id={workspace.id}
      data-color={workspace.color ?? undefined}
      style={workspace.color ? pastelVariables(workspace.color) : undefined}
    >
      <header onPointerDown={onStartDrag}>
        <button
          ref={mark}
          type="button"
          className="workspace-mark"
          style={{ background: markColorOf(workspace.name) }}
          aria-label="Workspace colour"
          aria-expanded={pickingColor}
          data-hint={hints.workspaceColor}
          onClick={togglePicker}
        >
          {initialsOf(workspace.name)}
        </button>
        <div className="workspace-heading" title={workspace.path}>
          <div className="workspace-name">{workspace.name}</div>
          <div className="workspace-folder">{parentFolder(workspace.path, homeDir)}</div>
        </div>
        <WaitingCount conversations={conversations} />
        <ConfirmButton
          className="icon"
          label="Remove workspace"
          hint={hints.removeWorkspace}
          armedText="Remove?"
          armedHint={hints.removeWorkspaceArmed}
          onConfirm={deleteWorkspace}
        >
          ×
        </ConfirmButton>
      </header>
      {pickingColor && <WorkspaceColorPicker workspace={workspace} mark={mark} onClose={closePicker} />}
      {conversations.length > 0 && (
        <ul ref={conversationList}>
          {conversations.map((conversation, index) => (
            <li
              key={conversation.id}
              data-reorder-id={conversation.id}
              className={[...rowClasses(conversation, selectedConversationId), ...conversationDrag.classesOf(conversation.id, index === conversations.length - 1)].join(" ")}
              onPointerDown={(event) => conversationDrag.startDrag(conversation.id, conversationList.current, event)}
              onClick={() => dispatch({ type: "select", conversationId: conversation.id })}
            >
              {statusDot(conversation)}
              <ConversationTitle conversation={conversation} startEditingOn="double-click" className="conversation-title" />
              {conversation.waitingFor && <WaitingPill waitingFor={conversation.waitingFor} />}
              <ConfirmButton
                className="icon"
                label="Delete conversation"
                hint={hints.deleteConversation}
                armedText="Delete?"
                armedHint={hints.deleteConversationArmed}
                onConfirm={() => deleteConversation(conversation)}
              >
                ×
              </ConfirmButton>
            </li>
          ))}
        </ul>
      )}
      <div className="workspace-actions">
        <button
          className="link"
          aria-label="+ New conversation"
          data-hint={hints.newConversation}
          data-shortcut={shortcutKeys().newConversation}
          onClick={() => startConversationIn(workspace, dispatch)}
        >
          + New
        </button>
        <LaunchPicker workspace={workspace} profiles={profiles} dispatch={dispatch} />
        <button
          className="link continue-session"
          aria-label="Continue a session…"
          data-hint={hints.continueSession}
          onClick={() => dispatch({ type: "open-overlay", overlay: { kind: "sessions", workspaceId: workspace.id } })}
        >
          Continue…
        </button>
      </div>
    </section>
  );
}

/** How many devices are connected now, besides the one looking; nothing while none is, or when switched off in Settings. */
function ConnectedDevices({ listed, onOpen }: { listed: DevicesListed | null; onOpen: () => void }) {
  const shown = useConnectedDevicesInSidebar();
  const connected = listed ? otherConnectedDevices(listed.devices, listed.thisDeviceId) : [];
  if (!shown || !listed || connected.length === 0) return null;
  return (
    <button type="button" className="link connected-devices" data-hint={hints.connectedDevices(connected.map(({ name }) => name))} onClick={onOpen}>
      {connectedDevicesLabel(connected.length, listed.thisDeviceId !== null)}
    </button>
  );
}

export function Sidebar({ state, dispatch }: { state: AppState; dispatch: Dispatch<AppAction> }) {
  const adding = state.overlay?.kind === "add-workspace";
  const setAdding = (open: boolean) => dispatch(open ? { type: "open-overlay", overlay: { kind: "add-workspace" } } : { type: "close-overlay" });
  const openOverlay = (overlay: Overlay) => dispatch({ type: "open-overlay", overlay });
  const sidebar = useRef<HTMLElement>(null);
  const workspaceDrag = useDragToReorder((workspaceId, beforeWorkspaceId) => connection.send({ type: "workspace.move", workspaceId, beforeWorkspaceId }));
  return (
    <nav className="sidebar" ref={sidebar}>
      <WaitingList state={state} dispatch={dispatch} />
      <header>
        <h1>Workspaces</h1>
        <button className="icon" aria-label="Add workspace" data-hint={hints.addWorkspace} data-shortcut={shortcutKeys().newWorkspace} onClick={() => setAdding(true)}>
          +
        </button>
      </header>
      {adding && <AddWorkspace onDone={() => setAdding(false)} />}
      {state.workspaces.length === 0 && !adding && (
        <button className="link" onClick={() => setAdding(true)}>
          + Add a project directory
        </button>
      )}
      {state.workspaces.map((workspace, index) => (
        <WorkspaceSection
          key={workspace.id}
          dragClasses={workspaceDrag.classesOf(workspace.id, index === state.workspaces.length - 1)}
          onStartDrag={(event) => workspaceDrag.startDrag(workspace.id, sidebar.current, event)}
          workspace={workspace}
          conversations={conversationsIn(state, workspace.id)}
          profiles={state.profiles}
          homeDir={state.homeDir}
          selectedConversationId={state.selectedConversationId}
          pickingColor={state.overlay?.kind === "workspace-color" && state.overlay.workspaceId === workspace.id}
          dispatch={dispatch}
        />
      ))}
      <footer>
        <ConnectedDevices listed={state.devices} onOpen={() => openOverlay({ kind: "settings", page: "devices" })} />
        <DesktopMenu />
        <div className="footer-buttons">
          <button className="link" data-hint={hints.settings} onClick={() => openOverlay({ kind: "settings" })}>
            Settings…
          </button>
          <button className="link" data-hint={hints.profiles} onClick={() => openOverlay({ kind: "profiles" })}>
            Profiles…
          </button>
          <button className="link" data-hint={hints.machines} onClick={() => openOverlay({ kind: "machines" })}>
            Machines…
          </button>
          <button className="link" data-hint={hints.searchAll} data-shortcut={shortcutKeys().search} onClick={() => openOverlay({ kind: "search" })}>
            Search…
          </button>
          <button className="link" onClick={() => openOverlay({ kind: "palette" })}>
            Palette <kbd>{shortcutKeys().palette}</kbd>
          </button>
          <button className="link" onClick={() => openOverlay({ kind: "help" })}>
            Shortcuts <kbd>{shortcutKeys().help}</kbd>
          </button>
        </div>
      </footer>
    </nav>
  );
}
