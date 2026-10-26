import { beforeEach, expect, test } from "bun:test";
import { createFoldStore } from "../web/workspace-groups.ts";

const saved = new Map<string, string>();

beforeEach(() => {
  saved.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => void saved.set(key, value),
  };
});

test("folding is remembered under the store's own key, and a second store with another key is unaffected", () => {
  const first = createFoldStore("first");
  const second = createFoldStore("second");
  first.setFolded("a", true);
  first.setFolded("b", true);
  first.setFolded("a", false);
  expect(JSON.parse(saved.get("first")!)).toEqual(["b"]);
  expect(saved.has("second")).toBe(false);
  second.setFolded("c", true);
  expect(JSON.parse(saved.get("first")!)).toEqual(["b"]);
});

test("a store starts from what was saved, ignoring what is not a list of ids", () => {
  saved.set("ids", JSON.stringify(["a", 3, "b"]));
  saved.set("junk", "{not json");
  saved.set("object", JSON.stringify({ a: 1 }));
  const reads = (key: string) => {
    const store = createFoldStore(key);
    store.setFolded("x", true);
    return JSON.parse(saved.get(key)!) as string[];
  };
  expect(reads("ids")).toEqual(["a", "b", "x"]);
  expect(reads("junk")).toEqual(["x"]);
  expect(reads("object")).toEqual(["x"]);
});
