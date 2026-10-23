import { useEffect, useRef, useState } from "react";
import type { AppDocumentState, InstalledApp, OpenApp } from "../shared/apps.ts";
import { appStateMessage, appViewPage, type CanvasFrameMessage } from "../shared/canvas-document.ts";
import { CanvasFrame } from "./Canvas.tsx";
import { connection, type ConnectionStatus } from "./connection.ts";

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

/** An app's view, live: its page loads once and every change to the document reaches it as a message. */
export function AppView({ openApp, installed, documentState, assetsOrigin }: { openApp: OpenApp; installed: InstalledApp; documentState: AppDocumentState | undefined; assetsOrigin: string }) {
  useAppSubscribed(openApp);
  const frame = useRef<HTMLIFrameElement>(null);
  const latest = useRef(documentState);
  latest.current = documentState;
  const frameId = `app:${openApp.workspaceId}/${openApp.app}`;
  const postState = () => latest.current && frame.current?.contentWindow?.postMessage(appStateMessage(latest.current), "*");

  useEffect(postState, [documentState]);

  const received = (message: CanvasFrameMessage) => {
    if (message.kind === "app-ready") postState();
    if (message.kind === "app-apply") connection.send({ type: "app.apply", workspaceId: openApp.workspaceId, app: openApp.app, op: message.op });
  };

  return (
    <div className="app-view">
      {documentState?.problem && (
        <p className="app-problem">
          {openApp.file} can't be read: {documentState.problem}. This is how it was before.
        </p>
      )}
      <CanvasFrame frameId={frameId} html={appViewPage(`${assetsOrigin}${installed.viewPath}`, frameId)} assetsOrigin={assetsOrigin} className="app" frameRef={frame} onMessage={received} />
    </div>
  );
}
