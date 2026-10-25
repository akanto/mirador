import type { ReviewItem, TourItem } from "../shared/model.ts";
import { useEnterWhileBusy } from "./busy-sending.ts";
import { connection } from "./connection.ts";
import { useReviewPaneShares } from "./paneLayouts.ts";
import { WalkthroughView } from "./Review.tsx";
import { useTypingAidAttributes } from "./typing-aids.ts";
import type { PlaceInWalkthrough, WalkthroughHost } from "./walkthrough-host.ts";
import { usePaneFullscreen } from "./Workspace.tsx";

/** Where the user was in each review or tour, while the page stays open. */
const placesInWalkthroughs = new Map<string, PlaceInWalkthrough>();

function readFile(itemId: string, path: string) {
  return connection.sendAndAwait(
    (requestId) => ({ type: "review.read-file", requestId, itemId, path }),
    (message, requestId) => {
      if (message.type === "review.file-read" && message.requestId === requestId) return message.lines;
      if (message.type === "review.file-failed" && message.requestId === requestId) throw new Error(message.message);
      return undefined;
    },
  );
}

/** What a review or tour in Mirador's own canvas does through the host connection and the page's settings. */
function usePanelWalkthroughHost(itemId: string, conversationId: string): WalkthroughHost {
  const enterWhileBusy = useEnterWhileBusy();
  return {
    openInEditor: (path, line) => void connection.send({ type: "review.open-in-editor", itemId, path, line }),
    updateFinding: (findingId, change) => void connection.send({ type: "review.update-finding", itemId, findingId, ...change }),
    updateAnswer: (answerId, change) => void connection.send({ type: "review.update-answer", itemId, answerId, ...change }),
    post: () => void connection.send({ type: "review.post", itemId }),
    reviewAgain: () => void connection.send({ type: "review.review-again", itemId }),
    readFile: (path) => readFile(itemId, path),
    checkGitHubCli: () =>
      connection.sendAndAwait(
        (requestId) => ({ type: "review.check-github-cli", requestId, itemId }),
        (message, requestId) => (message.type === "review.github-cli-checked" && message.requestId === requestId ? message.problem : undefined),
      ),
    ask: async (text) => connection.send({ type: "conversation.prompt", conversationId, text, imageIds: [], afterTurn: enterWhileBusy === "after-turn" }),
    fullscreen: usePaneFullscreen("canvas"),
    paneShares: useReviewPaneShares(),
    typingAidAttributes: useTypingAidAttributes(),
    placeLeft: () => placesInWalkthroughs.get(itemId),
    leavePlace: (place) => void placesInWalkthroughs.set(itemId, place),
  };
}

export function PanelWalkthrough({ item }: { item: ReviewItem | TourItem }) {
  return <WalkthroughView item={item} host={usePanelWalkthroughHost(item.id, item.conversationId)} />;
}
