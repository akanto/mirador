import { expect, test } from "bun:test";
import { LINES } from "../narration/lines.ts";
import { STORYBOARD } from "../src/storyboard.ts";

test("the storyboard speaks every line of the narration, once", () => {
  const spoken = STORYBOARD.flatMap((scene) => scene.narration ?? []).map(({ line }) => line);
  expect(spoken.toSorted()).toEqual(Object.keys(LINES).toSorted());
});
