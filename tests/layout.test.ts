import { expect, test } from "bun:test";
import { FACTORY_DEFAULT, arrangements, isPaneLayout, layoutFrom, placement, sidebarWidthWithinLimits, swapPanes, type PaneId } from "../web/layout.ts";

const everything: Record<PaneId, boolean> = { conversation: true, canvas: true, terminals: true };
const layout = { ...layoutFrom(FACTORY_DEFAULT), leftShare: 0.4, topShare: 0.6 };

test("there are six arrangements of the three panes, the factory default among them", () => {
  expect(new Set(arrangements.map((slots) => slots.join())).size).toBe(6);
  expect(arrangements[0]).toEqual(FACTORY_DEFAULT.slots);
});

test("all three panes shown: conversation on the left, canvas over terminals, with both dividers", () => {
  expect(placement(layout, everything, null)).toEqual({
    columns: "minmax(0, 0.4fr) var(--splitter-width) minmax(0, 0.6fr)",
    rows: "minmax(0, 0.6fr) var(--splitter-width) minmax(0, 0.4fr)",
    areas: { conversation: "1 / 1 / 4 / 2", canvas: "1 / 3 / 2 / 4", terminals: "3 / 3 / 4 / 4" },
    columnDivider: "1 / 2 / 4 / 3",
    rowDivider: "2 / 3 / 3 / 4",
  });
});

test("a hidden pane's tracks collapse while the others keep their areas", () => {
  const withoutCanvas = placement(layout, { ...everything, canvas: false }, null);
  expect(withoutCanvas.areas).toEqual({ conversation: "1 / 1 / 4 / 2", terminals: "3 / 3 / 4 / 4" });
  expect(withoutCanvas.rows).toBe("0 0 minmax(0, 1fr)");
  expect(withoutCanvas.rowDivider).toBeNull();

  const conversationOnly = placement(layout, { conversation: true, canvas: false, terminals: false }, null);
  expect(conversationOnly).toMatchObject({ columns: "minmax(0, 1fr) 0 0", columnDivider: null, rowDivider: null });
});

test("swapped onto the left, a pane that is then hidden leaves the right column the whole width", () => {
  const swapped = swapPanes(layout, "conversation", "canvas");
  expect(swapped.slots).toEqual(["canvas", "conversation", "terminals"]);
  const canvasHidden = placement(swapped, { ...everything, canvas: false }, null);
  expect(canvasHidden).toMatchObject({
    columns: "0 0 minmax(0, 1fr)",
    areas: { conversation: "1 / 3 / 2 / 4", terminals: "3 / 3 / 4 / 4" },
    columnDivider: null,
    rowDivider: "2 / 3 / 3 / 4",
  });
});

test("a fullscreen pane covers the whole area and the dividers go away; a hidden pane cannot be fullscreen", () => {
  const terminalsFullscreen = placement(layout, everything, "terminals");
  expect(terminalsFullscreen.areas.terminals).toBe("1 / 1 / 4 / 4");
  expect(terminalsFullscreen.areas.canvas).toBe("1 / 3 / 2 / 4");
  expect(terminalsFullscreen).toMatchObject({ columnDivider: null, rowDivider: null });
  expect(placement(layout, { ...everything, terminals: false }, "terminals").columnDivider).toBe("1 / 2 / 4 / 3");
});

test("stored layouts are checked before use", () => {
  expect(isPaneLayout(layout)).toBe(true);
  expect(isPaneLayout({ ...layout, slots: ["conversation", "conversation", "canvas"] })).toBe(false);
  expect(isPaneLayout({ ...layout, leftShare: 1.5 })).toBe(false);
  expect(isPaneLayout({ ...layout, hidden: { canvas: true } })).toBe(false);
  expect(isPaneLayout({ ...layout, fullscreen: "canvas" })).toBe(true);
  expect(isPaneLayout({ ...layout, fullscreen: "sidebar" })).toBe(false);
  expect(isPaneLayout({ ...layout, fullscreen: undefined })).toBe(false);
  expect(isPaneLayout(null)).toBe(false);
});

test("the sidebar keeps between 180 and 480 pixels wide, in whole pixels", () => {
  expect(sidebarWidthWithinLimits(90)).toBe(180);
  expect(sidebarWidthWithinLimits(300.6)).toBe(301);
  expect(sidebarWidthWithinLimits(900)).toBe(480);
});
