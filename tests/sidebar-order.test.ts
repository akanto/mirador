import { describe, expect, test } from "bun:test";
import { inSidebarOrder, movedBefore } from "../shared/sidebar-order.ts";

describe("sidebar order", () => {
  test("moves one id before another, or to the end", () => {
    expect(movedBefore(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
    expect(movedBefore(["a", "b", "c"], "a", "c")).toEqual(["b", "a", "c"]);
    expect(movedBefore(["a", "b", "c"], "a", null)).toEqual(["b", "c", "a"]);
    expect(movedBefore(["a", "b", "c"], "b", "b")).toEqual(["a", "b", "c"]);
  });

  test("leaves the order alone for an id it does not have, or a place among others", () => {
    expect(movedBefore(["a", "b"], "x", "a")).toEqual(["a", "b"]);
    expect(movedBefore(["a", "b"], "a", "elsewhere")).toEqual(["a", "b"]);
  });

  test("places by position, and by creation where positions are equal", () => {
    const things = [
      { id: "new", position: 0, createdAt: 3 },
      { id: "moved", position: -1, createdAt: 9 },
      { id: "old", position: 0, createdAt: 1 },
    ];
    expect(things.sort(inSidebarOrder).map(({ id }) => id)).toEqual(["moved", "old", "new"]);
  });
});
