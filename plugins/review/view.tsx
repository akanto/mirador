import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { PluginItemContext, PluginViewBridge } from "../../shared/canvas-document.ts";
import type { PluginItem } from "../../shared/canvas-plugins.ts";
import type { TourItem } from "../../shared/model.ts";
import type { Tour } from "../../shared/review.ts";
import { DEFAULT_FLOW_BAND_SHARE, DEFAULT_REVIEW_LIST_SHARE } from "../../web/paneLayouts.ts";
import { WalkthroughView } from "../../web/Review.tsx";
import { isMac } from "../../web/shortcuts.ts";
import mirador from "../../web/styles.css" with { type: "text" };
import type { WalkthroughHost } from "../../web/walkthrough-host.ts";
import viewStyles from "./view.css" with { type: "text" };
import type { Recalled, WalkthroughAction } from "./walkthrough-actions.ts";

const bridge = (window as unknown as { mirador: PluginViewBridge<Tour> }).mirador;

const send = (action: WalkthroughAction) => bridge.send(action);

const NOT_IN_A_TOUR = "A tour has no findings to post.";

/** The tour as the walkthrough view draws it, which it shares with Mirador's reviews. */
const tourItem = (item: PluginItem<Tour>): TourItem => ({ id: item.id, conversationId: "", kind: "tour", title: item.title, tour: item.data, status: "shown", createdAt: item.createdAt });

/** What a tour does through the plugin's bridge: the plugin's host code reads its files, keeps its layout and opens the editor. */
function useBridgedHost(item: PluginItem<Tour>, context: PluginItemContext, recalled: Recalled, onProblem: (problem: string) => void): WalkthroughHost {
  const [listShare, setListShare] = useState(recalled.paneShares?.listShare ?? DEFAULT_REVIEW_LIST_SHARE);
  const [bandShare, setBandShare] = useState(recalled.paneShares?.bandShare ?? DEFAULT_FLOW_BAND_SHARE);
  useEffect(() => void send({ kind: "remember-pane-shares", shares: { listShare, bandShare } }), [listShare, bandShare]);
  const failed = (error: unknown) => onProblem(error instanceof Error ? error.message : String(error));
  const typing = context.typingAids;
  return {
    openInEditor: (path, line) => void send({ kind: "open-in-editor", path, line }).catch(failed),
    updateFinding: () => failed(NOT_IN_A_TOUR),
    updateAnswer: () => failed(NOT_IN_A_TOUR),
    post: () => failed(NOT_IN_A_TOUR),
    reviewAgain: () => failed(NOT_IN_A_TOUR),
    readFile: async (path) => (await send({ kind: "read-file", path })) as string[],
    checkGitHubCli: async () => null,
    ask: (text) =>
      bridge.prompt(text).then(
        () => true,
        (error) => {
          failed(error);
          return false;
        },
      ),
    fullscreen: context.fullscreen === undefined ? null : { isFullscreen: context.fullscreen, setFullscreen: bridge.setFullscreen },
    paneShares: { listShare, setListShare, bandShare, setBandShare },
    typingAidAttributes: { autoCorrect: typing?.autocorrect ? "on" : "off", writingsuggestions: typing?.predictions ? "true" : "false" },
    placeLeft: () => recalled.place ?? undefined,
    leavePlace: (place) => void send({ kind: "leave-place", place }),
  };
}

function BridgedWalkthrough({ item, context, recalled }: { item: PluginItem<Tour>; context: PluginItemContext; recalled: Recalled }) {
  const [problem, setProblem] = useState<string | null>(null);
  const host = useBridgedHost(item, context, recalled, setProblem);
  return (
    <>
      {problem && (
        <p className="walkthrough-problem" role="alert">
          {problem}
        </p>
      )}
      <WalkthroughView item={tourItem(item)} host={host} />
    </>
  );
}

/** The view waits for what it recalls before its first paint, so the layout the user left doesn't jump into place. */
function WalkthroughPage() {
  const [shown, setShown] = useState<{ item: PluginItem<Tour>; context: PluginItemContext }>();
  const [recalled, setRecalled] = useState<Recalled>();
  useEffect(() => bridge.onItem((item, context) => setShown({ item, context })), []);
  useEffect(() => {
    send({ kind: "recall" }).then(
      (answer) => setRecalled(answer as Recalled),
      () => setRecalled({ paneShares: null, place: null }),
    );
  }, []);
  if (!shown || !recalled) return null;
  return <BridgedWalkthrough item={shown.item} context={shown.context} recalled={recalled} />;
}

/** The find shortcut finds in the code, as the review's own button does; the panel leaves it to the view. */
addEventListener("keydown", (event: KeyboardEvent) => {
  const primary = isMac ? event.metaKey : event.ctrlKey;
  if (!primary || event.altKey || event.shiftKey || event.code !== "KeyF") return;
  const trigger = document.querySelector<HTMLButtonElement>(".review-find-trigger");
  if (!trigger) return;
  event.preventDefault();
  trigger.click();
});

const style = document.createElement("style");
style.textContent = `${mirador}\n${viewStyles}`;
document.head.append(style);
const root = document.createElement("div");
root.id = "walkthrough";
document.body.append(root);
createRoot(root).render(<WalkthroughPage />);
