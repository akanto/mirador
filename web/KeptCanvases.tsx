import { memo, useMemo, useState } from "react";
import type { AppDocumentState, InstalledApp, OpenApp } from "../shared/apps.ts";
import { latestPlan } from "../shared/timeline.ts";
import { CanvasPanel, CanvasShown } from "./Canvas.tsx";
import { changesRefreshPoint } from "./changes.ts";
import { editRequestsIn } from "./edit-approval.ts";
import { useEditsInCanvas } from "./edits-in-canvas.ts";
import type { OpenConversation } from "./state.ts";

interface AppsState {
  openApps: OpenApp[];
  installedApps: InstalledApp[];
  appDocuments: Record<string, AppDocumentState>;
}

/** The conversations whose canvas was shown since the canvas pane last appeared, the one shown now included. */
function useShownSincePaneAppeared(shownId: string) {
  const [shown, setShown] = useState<ReadonlySet<string>>(() => new Set([shownId]));
  if (!shown.has(shownId)) setShown(new Set(shown).add(shownId));
  return shown;
}

/**
 * The canvas of each kept conversation it was shown in, the others hidden but still live, so that switching back to a
 * conversation finds its pages and apps as they were instead of loading them again. `kept` is in a fixed order: moving a
 * page's frame in the document would load it again too.
 */
export function KeptCanvases({
  kept,
  shownId,
  workspaceOf,
  apps,
  assetsOrigin,
  homeDir,
  canvasViews,
  onHide,
}: {
  kept: OpenConversation[];
  shownId: string;
  workspaceOf: (conversationId: string) => string | undefined;
  apps: AppsState;
  assetsOrigin: string;
  homeDir: string;
  canvasViews: Record<string, string>;
  onHide: () => void;
}) {
  const shownSincePaneAppeared = useShownSincePaneAppeared(shownId);
  const editsInCanvas = useEditsInCanvas();
  return kept
    .filter(({ conversationId }) => shownSincePaneAppeared.has(conversationId))
    .map((open) => (
      <KeptCanvas
        key={open.conversationId}
        open={open}
        shown={open.conversationId === shownId}
        workspaceId={workspaceOf(open.conversationId)}
        apps={apps}
        editsInCanvas={editsInCanvas}
        assetsOrigin={assetsOrigin}
        homeDir={homeDir}
        canvasViews={canvasViews}
        onHide={onHide}
      />
    ));
}

const KeptCanvas = memo(function KeptCanvas({
  open,
  shown,
  workspaceId,
  apps: { openApps, installedApps, appDocuments },
  editsInCanvas,
  assetsOrigin,
  homeDir,
  canvasViews,
  onHide,
}: {
  open: OpenConversation;
  shown: boolean;
  workspaceId: string | undefined;
  apps: AppsState;
  editsInCanvas: boolean;
  assetsOrigin: string;
  homeDir: string;
  canvasViews: Record<string, string>;
  onHide: () => void;
}) {
  const plan = useMemo(() => latestPlan(open.events), [open.events]);
  const edits = useMemo(() => (editsInCanvas ? editRequestsIn(open.events) : []), [open.events, editsInCanvas]);
  const refreshPoint = useMemo(() => changesRefreshPoint(open.events), [open.events]);
  const workspaceApps = useMemo(
    () => ({ open: openApps.filter((app) => app.workspaceId === workspaceId), installed: installedApps, documents: appDocuments }),
    [openApps, installedApps, appDocuments, workspaceId],
  );
  return (
    <div className="kept-canvas" style={{ display: shown ? "contents" : "none" }}>
      <CanvasShown.Provider value={shown}>
        <CanvasPanel
          conversationId={open.conversationId}
          items={open.canvas}
          plan={plan}
          edits={edits}
          assetsOrigin={assetsOrigin}
          homeDir={homeDir}
          changesRefreshPoint={refreshPoint}
          apps={workspaceApps}
          canvasViews={canvasViews}
          onHide={onHide}
        />
      </CanvasShown.Provider>
    </div>
  );
});
