import { useEffect, useRef, useState, type Dispatch, type KeyboardEvent } from "react";
import { harnessIds, launchLabel, terminalActivityLabels, type Conversation, type Launch, type Profile, type Workspace } from "../shared/model.ts";
import { connection } from "./connection.ts";
import { ConversationTitle } from "./ConversationTitle.tsx";
import { startConversationIn } from "./actions.ts";
import { conversationsIn } from "./navigation.ts";
import { isMac } from "./shortcuts.ts";
import type { AppAction, AppState, Overlay } from "./state.ts";
import { themeLabels, useTheme, type Theme } from "./theme.ts";
import { useTimestampsShown } from "./timestamps.ts";

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
  const inTerminal = conversation.openInTerminal;
  if (inTerminal && conversation.status === "idle") {
    return <span className={`dot terminal-${inTerminal}`} title={`Open in a terminal: ${terminalActivityLabels[inTerminal]}`} />;
  }
  return <span className={`dot status-${conversation.status}`} title={conversation.statusDetail ?? conversation.status} />;
}

const launchKey = ({ harness, profileId }: Launch) => profileId ?? harness;

/** Every agent on its own, then every profile (each belongs to one agent). */
const launchChoices = (profiles: Profile[]): Launch[] => [
  ...harnessIds.map((harness) => ({ harness, profileId: null })),
  ...profiles.map(({ id, harness }) => ({ harness, profileId: id })),
];

function LaunchPicker({ workspace, profiles }: { workspace: Workspace; profiles: Profile[] }) {
  const choices = launchChoices(profiles);
  const choose = (key: string) => {
    const launch = choices.find((choice) => launchKey(choice) === key);
    if (launch) connection.send({ type: "workspace.set-default-launch", workspaceId: workspace.id, launch });
  };
  return (
    <select
      aria-label="Agent"
      title="Agent (and profile) for new conversations in this workspace"
      value={launchKey(workspace.defaultLaunch)}
      onChange={(event) => choose(event.target.value)}
    >
      {choices.map((launch) => (
        <option key={launchKey(launch)} value={launchKey(launch)}>
          {launchLabel(launch, profiles)}
        </option>
      ))}
    </select>
  );
}

function WorkspaceSection({
  workspace,
  conversations,
  profiles,
  selectedConversationId,
  dispatch,
}: {
  workspace: Workspace;
  conversations: Conversation[];
  profiles: Profile[];
  selectedConversationId: string | null;
  dispatch: Dispatch<AppAction>;
}) {

  const deleteWorkspace = () => {
    if (confirm(`Remove workspace ${workspace.name} and its ${conversations.length} conversation(s) from the app? Files on disk are not touched.`)) {
      connection.send({ type: "workspace.delete", workspaceId: workspace.id });
    }
  };
  const deleteConversation = (conversation: Conversation) => {
    if (confirm(`Delete conversation "${conversation.title}"?`)) {
      connection.send({ type: "conversation.delete", conversationId: conversation.id });
    }
  };

  return (
    <section className="workspace">
      <header>
        <div className="workspace-name" title={workspace.path}>
          {workspace.name}
        </div>
        <button className="icon" title="Remove workspace" onClick={deleteWorkspace}>
          ×
        </button>
      </header>
      <div className="workspace-path">{workspace.path}</div>
      <ul>
        {conversations.map((conversation) => (
          <li
            key={conversation.id}
            className={conversation.id === selectedConversationId ? "selected" : ""}
            onClick={() => dispatch({ type: "select", conversationId: conversation.id })}
          >
            {statusDot(conversation)}
            <ConversationTitle conversation={conversation} startEditingOn="double-click" className="conversation-title" />
            <button
              className="icon"
              title="Delete conversation"
              onClick={(event) => {
                event.stopPropagation();
                deleteConversation(conversation);
              }}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <div className="new-conversation">
        <button className="link" onClick={() => startConversationIn(workspace, dispatch)}>
          + New conversation
        </button>
        <LaunchPicker workspace={workspace} profiles={profiles} />
      </div>
      <button className="link" onClick={() => dispatch({ type: "open-overlay", overlay: { kind: "sessions", workspaceId: workspace.id } })}>
        Continue a session…
      </button>
    </section>
  );
}

function ThemePicker() {
  const [theme, setTheme] = useTheme();
  return (
    <label className="theme-picker">
      Theme
      <select value={theme} onChange={(event) => setTheme(event.target.value as Theme)}>
        {Object.entries(themeLabels).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
}

function TimestampsToggle() {
  const [shown, setShown] = useTimestampsShown();
  return (
    <label className="timestamps-toggle" title="Off: point at a line to see its time">
      <input type="checkbox" checked={shown} onChange={(event) => setShown(event.target.checked)} />
      Show timestamps
    </label>
  );
}

export function Sidebar({ state, dispatch }: { state: AppState; dispatch: Dispatch<AppAction> }) {
  const adding = state.overlay?.kind === "add-workspace";
  const setAdding = (open: boolean) => dispatch(open ? { type: "open-overlay", overlay: { kind: "add-workspace" } } : { type: "close-overlay" });
  const openOverlay = (overlay: Overlay) => dispatch({ type: "open-overlay", overlay });
  return (
    <nav className="sidebar">
      <header>
        <h1>Workspaces</h1>
        <button className="icon" title="Add workspace" onClick={() => setAdding(true)}>
          +
        </button>
      </header>
      {adding && <AddWorkspace onDone={() => setAdding(false)} />}
      {state.workspaces.length === 0 && !adding && (
        <button className="link" onClick={() => setAdding(true)}>
          + Add a project directory
        </button>
      )}
      {state.workspaces.map((workspace) => (
        <WorkspaceSection
          key={workspace.id}
          workspace={workspace}
          conversations={conversationsIn(state, workspace.id)}
          profiles={state.profiles}
          selectedConversationId={state.selectedConversationId}
          dispatch={dispatch}
        />
      ))}
      <footer>
        <button className="link" onClick={() => openOverlay({ kind: "profiles" })}>
          Profiles…
        </button>
        <button className="link" onClick={() => openOverlay({ kind: "palette" })}>
          Palette <kbd>{isMac ? "⌘K" : "Ctrl+K"}</kbd>
        </button>
        <button className="link" onClick={() => openOverlay({ kind: "help" })}>
          Shortcuts <kbd>?</kbd>
        </button>
        <ThemePicker />
        <TimestampsToggle />
      </footer>
    </nav>
  );
}
