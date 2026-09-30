import { useEffect, useState, type Dispatch } from "react";
import { harnessLabels, launchLabel, type AdoptMode, type ExternalSession, type Profile, type Workspace } from "../shared/model.ts";
import { connection } from "./connection.ts";
import type { AppAction } from "./state.ts";

type Listing = { state: "loading" } | { state: "failed"; message: string } | { state: "listed"; sessions: ExternalSession[] };

function useWorkspaceSessions(workspace: Workspace) {
  const [listing, setListing] = useState<Listing>({ state: "loading" });
  useEffect(() => {
    const requestId = crypto.randomUUID();
    const unsubscribe = connection.onMessage((message) => {
      if (message.type === "sessions.listed" && message.requestId === requestId) setListing({ state: "listed", sessions: message.sessions });
      if (message.type === "sessions.failed" && message.requestId === requestId) setListing({ state: "failed", message: message.message });
    });
    connection.send({ type: "sessions.list", requestId, workspaceId: workspace.id, launch: workspace.defaultLaunch });
    return unsubscribe;
  }, [workspace.id, workspace.defaultLaunch.harness, workspace.defaultLaunch.profileId]);
  return listing;
}

const relativeTime = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

function ago(isoTime: string | null) {
  if (!isoTime) return "";
  const minutes = Math.round((Date.parse(isoTime) - Date.now()) / 60_000);
  if (Math.abs(minutes) < 60) return relativeTime.format(minutes, "minute");
  if (Math.abs(minutes) < 48 * 60) return relativeTime.format(Math.round(minutes / 60), "hour");
  return relativeTime.format(Math.round(minutes / (24 * 60)), "day");
}

export function SessionsDialog({
  workspace,
  profiles,
  dispatch,
  onClose,
}: {
  workspace: Workspace;
  profiles: Profile[];
  dispatch: Dispatch<AppAction>;
  onClose: () => void;
}) {
  const listing = useWorkspaceSessions(workspace);
  const agent = harnessLabels[workspace.defaultLaunch.harness];

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const adopt = (session: ExternalSession, mode: AdoptMode) => {
    dispatch({ type: "awaiting-conversation", workspaceId: workspace.id });
    connection.send({
      type: "conversation.adopt",
      workspaceId: workspace.id,
      launch: workspace.defaultLaunch,
      session: { sessionId: session.sessionId, title: session.title },
      mode,
    });
    onClose();
  };
  const open = (conversationId: string) => {
    dispatch({ type: "select", conversationId });
    onClose();
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal sessions" role="dialog" aria-label="Continue a session">
        <header>
          <h2>Continue a session in {workspace.name}</h2>
          <button className="icon" title="Close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>
        <p className="hint">
          {agent} sessions started in <code>{workspace.path}</code>, newest first, including ones from a terminal. They continue
          as <strong>{launchLabel(workspace.defaultLaunch, profiles)}</strong>, the workspace's choice next to{" "}
          <em>New conversation</em>.
        </p>
        <p className="warning">
          <strong>Continue</strong> keeps the same session. If it is still open in a terminal, both would write to it, so close
          it there first. <strong>Fork</strong> copies the history into a new session and leaves the original alone.
        </p>
        {listing.state === "loading" && <div className="notice-line">Loading sessions…</div>}
        {listing.state === "failed" && <div className="form-errors">{listing.message}</div>}
        {listing.state === "listed" && listing.sessions.length === 0 && (
          <div className="notice-line">No {agent} sessions in this directory yet.</div>
        )}
        {listing.state === "listed" && listing.sessions.length > 0 && (
          <ul className="session-list">
            {listing.sessions.map((session) => (
              <li key={session.sessionId}>
                <div className="session-summary">
                  <div className="session-title">{session.title || "(untitled)"}</div>
                  <div className="session-meta">
                    {ago(session.updatedAt)} · <code>{session.sessionId.slice(0, 8)}</code>
                  </div>
                </div>
                {session.conversationId ? (
                  <button onClick={() => open(session.conversationId!)}>Open</button>
                ) : (
                  <>
                    <button className="primary" onClick={() => adopt(session, "continue")}>
                      Continue
                    </button>
                    <button onClick={() => adopt(session, "fork")}>Fork</button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
