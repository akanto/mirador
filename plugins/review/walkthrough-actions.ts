import type { PlaceInWalkthrough } from "../../web/walkthrough-host.ts";

export interface StoredPaneShares {
  listShare: number;
  bandShare: number;
}

/** What the view sends the plugin's host code. */
export type WalkthroughAction =
  | { kind: "recall" }
  | { kind: "remember-pane-shares"; shares: StoredPaneShares }
  | { kind: "leave-place"; place: PlaceInWalkthrough }
  | { kind: "read-file"; path: string }
  | { kind: "open-in-editor"; path: string; line: number };

/** What the view draws with from its first paint: the pane shares the user last left, and where they were in this item. */
export interface Recalled {
  paneShares: StoredPaneShares | null;
  place: PlaceInWalkthrough | null;
}
