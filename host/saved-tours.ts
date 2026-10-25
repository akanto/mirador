import type { CanvasItemBase, PluginCanvasItem } from "../shared/model.ts";
import type { Tour } from "../shared/review.ts";

/** A tour as Mirador saved it before tours came from the review plugin. */
export interface SavedTour extends Omit<CanvasItemBase, "kind"> {
  kind: "tour";
  tour: Tour;
}

/** The review plugin's item for a tour saved before it. Changed now, so a device catching up on what changed since it last looked gets it too. */
export const pluginItemOfSavedTour = ({ tour, kind: _, ...base }: SavedTour, now: number): PluginCanvasItem => ({
  ...base,
  kind: "plugin",
  plugin: "review",
  type: "tour",
  icon: "↯",
  placement: "page",
  data: tour,
  updatedAt: now,
});
