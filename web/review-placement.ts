import type { CanvasItem } from "../shared/model.ts";
import { storedChoice } from "./stored-choice.ts";

/** Where a review opens: the canvas pane filling the workspace, or the canvas pane beside the chat. */
export type ReviewPlacement = "fullscreen" | "beside";

export const reviewPlacementLabels: Record<ReviewPlacement, string> = {
  fullscreen: "Full screen, over the chat",
  beside: "In the canvas pane, beside the chat",
};

const reviewPlacement = storedChoice<ReviewPlacement>("mirador-review-placement", ["fullscreen", "beside"], "fullscreen");

export const setReviewPlacement = reviewPlacement.set;
export const useReviewPlacement = reviewPlacement.use;
export const currentReviewPlacement = reviewPlacement.get;

const FRESH_REVIEW_MS = 30_000;
const placedOnArrival = new Set<string>();

/** A review that just arrived opens where the setting says, once; one opened again later stays where the user put the pane. */
export function takeArrivedReview(item: CanvasItem | undefined) {
  if (item?.kind !== "review" || Date.now() - item.createdAt > FRESH_REVIEW_MS || placedOnArrival.has(item.id)) return false;
  placedOnArrival.add(item.id);
  return true;
}

export const isFreshReview = (item: CanvasItem | undefined) => item?.kind === "review" && Date.now() - item.createdAt <= FRESH_REVIEW_MS;
