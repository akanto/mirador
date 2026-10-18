import { describe, expect, test } from "bun:test";
import {
  applyChecklistEdit,
  carriedOverDone,
  dismissedByUser,
  heardOf,
  newChecklist,
  noteOfTicks,
  tickedByUser,
  unheardTicks,
  withChecklistNote,
  type ChecklistEdit,
  type ChecklistRequest,
} from "../host/canvas/checklist.ts";
import { ReviewProblems } from "../host/review/snapshot.ts";
import { checklistItems, type Checklist } from "../shared/checklist.ts";
import type { StoredEvent } from "../shared/model.ts";
import { latestPlan } from "../shared/timeline.ts";

const release: ChecklistRequest = {
  title: "Release 0.4.2",
  sections: [
    { title: "Build", items: [{ id: "tests", text: "Run the tests", done: true }, { id: "build", text: "Build the app", detail: "Signed and *notarized*" }] },
    { title: "Ship", items: [{ id: "publish", text: "Publish the release" }, { id: "announce", text: "Post the announcement", owner: "user" }] },
  ],
};

const published = () => newChecklist(release, undefined);

const problemsOf = (attempt: () => unknown) => {
  try {
    attempt();
    return [];
  } catch (error) {
    return (error as ReviewProblems).problems;
  }
};

const states = (checklist: Checklist) => checklistItems(checklist).map(({ id, done, heardDone }) => `${id}:${done ? "done" : "open"}${done === heardDone ? "" : " (unheard)"}`);

describe("newChecklist", () => {
  test("keeps the sections and items as given, the agent's by default and not done, each done one known to the agent", () => {
    const checklist = published();
    expect(checklist.sections.map(({ title }) => title)).toEqual(["Build", "Ship"]);
    expect(checklistItems(checklist).map(({ id, owner }) => `${id}:${owner}`)).toEqual(["tests:agent", "build:agent", "publish:agent", "announce:user"]);
    expect(states(checklist)).toEqual(["tests:done", "build:open", "publish:open", "announce:open"]);
    expect(checklistItems(checklist)[1]!.detail).toBe("Signed and *notarized*");
  });

  test("an id given to two items is a problem, and nothing is published", () => {
    const twice = { title: "T", sections: [{ items: [{ id: "a", text: "A" }] }, { items: [{ id: "a", text: "A again" }, { id: "b", text: "B" }] }] };
    expect(problemsOf(() => newChecklist(twice, undefined))).toEqual(['"a" names more than one item; give each item its own id.']);
  });

  test("published again, items with the same ids keep their ticks unless the agent says otherwise", () => {
    const earlier = tickedByUser(published(), "publish", true);
    const again: ChecklistRequest = {
      title: "Release 0.4.2",
      sections: [{ items: [{ id: "tests", text: "Run the tests", done: false }, { id: "publish", text: "Publish" }, { id: "docs", text: "Update the docs" }] }],
    };
    const checklist = newChecklist(again, earlier);
    expect(states(checklist)).toEqual(["tests:open", "publish:done", "docs:open"]);
    expect(carriedOverDone(again, checklist).map(({ id }) => id)).toEqual(["publish"]);
    expect(checklist.sections[0]!.title).toBeUndefined();
  });
});

describe("applyChecklistEdit", () => {
  test("ticks, rewords and hands over items by id; only the fields given change", () => {
    const edit: ChecklistEdit = { items: [{ id: "build", done: true }, { id: "announce", text: "Announce it", owner: "both" }] };
    const { checklist, changed, added, removed } = applyChecklistEdit(published(), edit);
    expect(states(checklist)).toEqual(["tests:done", "build:done", "publish:open", "announce:open"]);
    const [, build, , announce] = checklistItems(checklist);
    expect(build).toMatchObject({ text: "Build the app", detail: "Signed and *notarized*" });
    expect(announce).toMatchObject({ text: "Announce it", owner: "both" });
    expect({ changed, added, removed }).toEqual({ changed: ["build", "announce"], added: [], removed: [] });
  });

  test("adds items after one it names, at the end of a section it names, in a new section, or at the end of the last", () => {
    const edit: ChecklistEdit = {
      addItems: [
        { id: "lint", text: "Lint", after: "tests" },
        { id: "checksums", text: "Checksums", section: "Build" },
        { id: "tap", text: "Update the tap" },
        { id: "watch", text: "Watch the update", section: "After" },
        { id: "smoke", text: "Smoke test", after: "lint" },
      ],
    };
    const { checklist, added } = applyChecklistEdit(published(), edit);
    expect(checklist.sections.map(({ title, items }) => `${title}: ${items.map(({ id }) => id).join(" ")}`)).toEqual([
      "Build: tests lint smoke build checksums",
      "Ship: publish announce tap",
      "After: watch",
    ]);
    expect(added).toEqual(["lint", "checksums", "tap", "watch", "smoke"]);
  });

  test("takes items out, and a section left empty with them", () => {
    const { checklist, removed } = applyChecklistEdit(published(), { removeItems: ["publish", "announce"] });
    expect(checklist.sections.map(({ title }) => title)).toEqual(["Build"]);
    expect(removed).toEqual(["publish", "announce"]);
  });

  test("every problem is listed, and nothing changes", () => {
    const edit: ChecklistEdit = {
      items: [{ id: "nope", done: true }, { id: "build", done: true }, { id: "build", text: "Again" }, { id: "publish", done: true }],
      removeItems: ["publish", "gone"],
      addItems: [{ id: "tests", text: "Tests again" }, { id: "late", text: "Late", after: "publish" }, { id: "lost", text: "Lost", after: "missing" }],
    };
    const ids = "tests, build, publish, announce";
    expect(problemsOf(() => applyChecklistEdit(published(), edit))).toEqual([
      `"nope" is not an item of this checklist (${ids}).`,
      '"build" is changed twice; change each item once.',
      `"gone" is not an item of this checklist (${ids}).`,
      '"publish" is both changed and taken out; pick one.',
      `"tests" is already an item's id; give the new item its own.`,
      '"late" goes after "publish", which is not an item of this checklist once the ones you take out are gone.',
      '"lost" goes after "missing", which is not an item of this checklist.',
    ]);
    expect(problemsOf(() => applyChecklistEdit(published(), {}))).toEqual(["Nothing to change: pass items to change, add or take out."]);
  });

  test("the agent's tick settles one of the user's it had not heard of", () => {
    const unticked = tickedByUser(published(), "tests", false);
    expect(states(unticked)).toEqual(["tests:open (unheard)", "build:open", "publish:open", "announce:open"]);
    expect(states(applyChecklistEdit(unticked, { items: [{ id: "tests", done: true }] }).checklist)[0]).toBe("tests:done");
  });
});

describe("the user's ticks", () => {
  test("are news to the agent until it hears of them, and ticking back and forth before then is no news", () => {
    const ticked = tickedByUser(tickedByUser(tickedByUser(published(), "publish", true), "tests", false), "build", true);
    const backAgain = tickedByUser(ticked, "build", false);
    expect(unheardTicks(backAgain)).toEqual([
      { id: "tests", text: "Run the tests", done: false },
      { id: "publish", text: "Publish the release", done: true },
    ]);
  });

  test("the note names each item by id and text", () => {
    const ticks = unheardTicks(tickedByUser(tickedByUser(tickedByUser(published(), "publish", true), "announce", true), "tests", false));
    const note = noteOfTicks("Release 0.4.2", ticks);
    expect(note).toBe('On your checklist "Release 0.4.2", the user ticked "publish" (Publish the release), "announce" (Post the announcement) and unticked "tests" (Run the tests).');
    expect(withChecklistNote({ text: note, heard: () => {} }, "Go on")).toBe(`${note}\n\nGo on`);
    expect(withChecklistNote(null, "Go on")).toBe("Go on");
  });

  test("once heard, only what the agent was told counts as heard: a tick made since is still news", () => {
    const ticked = tickedByUser(published(), "publish", true);
    const told = unheardTicks(ticked);
    const tickedSince = tickedByUser(ticked, "build", true);
    expect(unheardTicks(heardOf(tickedSince, told))).toEqual([{ id: "build", text: "Build the app", done: true }]);
  });
});

describe("dismissedByUser", () => {
  test("marks the checklist dismissed, keeping its sections and ticks; a checklist published after it is a fresh one", () => {
    const ticked = tickedByUser(published(), "publish", true);
    const dismissed = dismissedByUser(ticked);
    expect(dismissed.dismissed).toBe(true);
    expect(states(dismissed)).toEqual(states(ticked));
    expect(newChecklist(release, dismissed).dismissed).toBeUndefined();
  });
});

const planEvent = (seq: number, entries: { content: string; status: "pending" | "in_progress" | "completed" }[], meta?: Record<string, unknown>): StoredEvent => ({
  seq,
  at: seq,
  event: { type: "acp", update: { sessionUpdate: "plan", entries: entries.map((entry) => ({ ...entry, priority: "medium" })), ...(meta && { _meta: meta }) } },
});

describe("latestPlan", () => {
  test("is the agent's newest plan, across turns; a subagent's plan or an emptied one leaves it standing", () => {
    const events: StoredEvent[] = [
      planEvent(1, [{ content: "Old", status: "completed" }]),
      planEvent(2, [{ content: "Read the code", status: "completed" }, { content: "Write the tool", status: "in_progress" }]),
      { seq: 3, at: 3, event: { type: "turn-end", stopReason: "end_turn" } },
      { seq: 4, at: 4, event: { type: "user-message", text: "Next" } },
      planEvent(5, [{ content: "Subagent step", status: "pending" }], { claudeCode: { parentToolUseId: "toolu_1" } }),
      planEvent(6, []),
    ];
    expect(latestPlan(events)?.map(({ content }) => content)).toEqual(["Read the code", "Write the tool"]);
    expect(latestPlan(events.slice(2, 4))).toBeNull();
  });
});
