import { expect, test } from "bun:test";
import { forgetSessionsOf } from "../host/conversations.ts";

const bound = () => new Map([
  ["ses_old", "c1"],
  ["ses_new", "c1"],
  ["ses_other", "c2"],
]);

test("a conversation that moved to a newer session leaves no mapping of the old one behind", () => {
  const bySession = bound();
  forgetSessionsOf(bySession, "c1", "ses_new");
  expect([...bySession]).toEqual([
    ["ses_new", "c1"],
    ["ses_other", "c2"],
  ]);
});

test("a deleted conversation leaves no mapping of any session behind, newest included", () => {
  const bySession = bound();
  forgetSessionsOf(bySession, "c1");
  expect([...bySession]).toEqual([["ses_other", "c2"]]);
});

test("forgetting a conversation that never had a session changes nothing", () => {
  const bySession = bound();
  forgetSessionsOf(bySession, "c3");
  expect(bySession.size).toBe(3);
});
