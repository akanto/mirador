import { useEffect, useRef, useState } from "react";
import { appPromptText, type AppDocumentState, type InstalledApp, type OpenApp } from "../shared/apps.ts";
import { appStateMessage, appViewPage, type CanvasFrameMessage } from "../shared/canvas-document.ts";
import { useEnterWhileBusy } from "./busy-sending.ts";
import { CanvasFrame } from "./Canvas.tsx";
import { connection, type ConnectionStatus } from "./connection.ts";
import { usePaneFullscreen } from "./Workspace.tsx";

const SENT_NOTE_MS = 8000;

/** The page gets the app's document only while it shows the app, and again after it reconnects. */
function useAppSubscribed({ workspaceId, app }: OpenApp) {
  const [status, setStatus] = useState<ConnectionStatus>(connection.status);
  useEffect(() => connection.onStatus(setStatus), []);
  useEffect(() => {
    if (status !== "open") return;
    connection.send({ type: "app.subscribe", workspaceId, app });
    return () => void connection.send({ type: "app.unsubscribe", workspaceId, app });
  }, [status, workspaceId, app]);
}

/** Sends what the user wrote in the view to the conversation's agent, and says for a while that it went. */
function useAppPrompt(openApp: OpenApp, conversationId: string) {
  const enterWhileBusy = useEnterWhileBusy();
  const [sentAt, setSentAt] = useState<number | null>(null);
  useEffect(() => {
    if (sentAt === null) return;
    const timer = setTimeout(() => setSentAt(null), SENT_NOTE_MS);
    return () => clearTimeout(timer);
  }, [sentAt]);
  const prompt = (text: unknown) => {
    if (typeof text !== "string" || !text.trim()) return;
    if (!connection.send({ type: "conversation.prompt", conversationId, text: appPromptText(openApp, text), imageIds: [], afterTurn: enterWhileBusy === "after-turn" })) return;
    setSentAt(Date.now());
  };
  return { prompt, sent: sentAt !== null };
}

/** An app's view, live: its page loads once and every change to the document reaches it as a message. */
export function AppView({
  openApp,
  installed,
  documentState,
  assetsOrigin,
  conversationId,
}: {
  openApp: OpenApp;
  installed: InstalledApp;
  documentState: AppDocumentState | undefined;
  assetsOrigin: string;
  conversationId: string;
}) {
  useAppSubscribed(openApp);
  const { prompt, sent } = useAppPrompt(openApp, conversationId);
  const fullscreen = usePaneFullscreen("canvas");
  const frame = useRef<HTMLIFrameElement>(null);
  const latest = useRef(documentState);
  latest.current = documentState;
  const frameId = `app:${openApp.workspaceId}/${openApp.app}`;
  const postState = () => latest.current && frame.current?.contentWindow?.postMessage(appStateMessage(latest.current), "*");

  useEffect(postState, [documentState]);

  const received = (message: CanvasFrameMessage) => {
    if (message.kind === "app-ready") postState();
    if (message.kind === "app-apply") connection.send({ type: "app.apply", workspaceId: openApp.workspaceId, app: openApp.app, op: message.op });
    if (message.kind === "app-prompt") prompt(message.text);
  };

  return (
    <div className="app-view">
      {documentState?.problem && (
        <p className="app-problem">
          {openApp.file} can't be read: {documentState.problem}. This is how it was before.
        </p>
      )}
      <CanvasFrame frameId={frameId} html={appViewPage(`${assetsOrigin}${installed.viewPath}`, frameId)} assetsOrigin={assetsOrigin} className="app" frameRef={frame} onMessage={received} />
      {sent && (
        <div className="app-sent" role="status">
          Sent to the agent. The answer comes in the chat.
          {fullscreen?.isFullscreen && (
            <button type="button" className="link" onClick={() => fullscreen.setFullscreen(false)}>
              Show the chat
            </button>
          )}
        </div>
      )}
    </div>
  );
}
