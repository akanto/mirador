import { describe, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationService } from "../host/conversations.ts";
import { answerAsToolResult, CanvasService } from "../host/canvas/service.ts";
import { Hub } from "../host/hub.ts";
import { Store } from "../host/store.ts";
import type { SystemNotifications } from "../host/system-notifications.ts";
import { questionsOf } from "../shared/ask.ts";
import type { AskItem, CanvasItem, ReviewItem } from "../shared/model.ts";
import type { Review, ReviewAnswer, ReviewFinding } from "../shared/review.ts";
import type { NotificationReason } from "../shared/system-notifications.ts";
import { completeDirectories } from "../host/paths.ts";
import type { GitHubCli } from "../host/review/github.ts";
import type { ReviewProblems } from "../host/review/snapshot.ts";
import { gitRepository, reviewRequest } from "./review-repository.ts";

function asAsk(item: CanvasItem | undefined) {
  expect(item?.kind).toBe("ask");
  return item as AskItem | undefined;
}

function asReview(item: CanvasItem | undefined) {
  expect(item?.kind).toBe("review");
  return (item as ReviewItem | undefined)?.review;
}

function setUp(hub = new Hub(), gh?: GitHubCli) {
  const store = new Store(":memory:");
  store.insertWorkspace({ id: "w1", name: "p", path: "/tmp/p", defaultLaunch: { harness: "claude", profileId: null }, createdAt: 1 });
  store.insertConversation({
    id: "c1",
    workspaceId: "w1",
    harness: "claude",
    profileId: null,
    title: "t",
    titleSetByUser: false,
    acpSessionId: null,
    askMode: "wait",
    bypassPermissions: false,
    status: "idle",
    statusDetail: null,
    openInTerminal: null,
    contextUsage: null,
    queuedMessages: [],
    usageLimit: null,
    jobWaits: [],
    asyncTasks: [],
    waitingFor: null,
    pendingRequest: null,
    lastWords: null,
    activity: null,
    configOptions: [],
    createdAt: 1,
    updatedAt: 1,
  });
  const nextMessages: string[] = [];
  const sendOptions: unknown[] = [];
  const questionsChanged: string[] = [];
  const conversations = {
    send: async (_id: string, text: string, _imageIds?: string[], options?: unknown) => {
      nextMessages.push(text);
      sendOptions.push(options);
    },
    questionsChanged: (conversationId: string) => void questionsChanged.push(conversationId),
  } as unknown as ConversationService;
  const notified: [string, NotificationReason][] = [];
  const notifications = { notify: (conversationId: string, reason: NotificationReason) => void notified.push([conversationId, reason]) } as SystemNotifications;
  const canvas = new CanvasService(store, hub, conversations, notifications, ["http://127.0.0.1:4601"], gh);
  const ask = () => canvas.openAsk("c1", { question: "Color?", options: [{ label: "Red" }, { label: "Blue" }] });
  const askSeveral = () =>
    canvas.openAsk("c1", {
      questions: [
        { question: "Color?", options: [{ label: "Red" }, { label: "Blue" }] },
        { question: "Size?", options: [{ label: "Small" }, { label: "Large" }], allowOther: true },
      ],
    });
  return { store, canvas, nextMessages, sendOptions, ask, askSeveral, notified, questionsChanged };
}

describe("CanvasService", () => {
  test("a question asks for a system notification", () => {
    const { ask, notified } = setUp();
    ask();
    expect(notified).toEqual([["c1", { kind: "question", question: "Color?" }]]);
  });

  test("a question keeps the least width the agent asked for its answer boxes", () => {
    const { store, canvas, ask } = setUp();
    const roomy = canvas.openAsk("c1", { question: "Which fix?", options: [{ label: "Fix" }, { label: "Leave" }], optionWidth: 480 });
    expect(asAsk(store.findCanvasItem(roomy.id))?.optionWidth).toBe(480);
    expect(asAsk(store.findCanvasItem(ask().id))).not.toHaveProperty("optionWidth");
  });

  test("the conversation hears when its question opens, is answered and is withdrawn, but not about pages shown", async () => {
    const { canvas, ask, questionsChanged } = setUp();
    canvas.answer(ask().id, "Red");
    ask();
    canvas.withdrawWaitingAsks("c1");
    await canvas.show("c1", { title: "x", html: "<p>" });
    expect(questionsChanged).toEqual(["c1", "c1", "c1", "c1"]);
  });

  test("a question carries the pages shown since the user last wrote or answered, so both are seen together", async () => {
    const { store, canvas, ask } = setUp();
    setSystemTime(new Date("2026-10-02T10:00:00Z"));
    const seenEarlier = await canvas.show("c1", { title: "seen", html: "<p>seen" });
    canvas.answer(ask().id, "Red");
    await canvas.show("c1", { title: "also seen", html: "<p>also" });
    setSystemTime(new Date("2026-10-02T10:01:00Z"));
    store.appendEvent("c1", { type: "user-message", text: "explain it" });
    setSystemTime(new Date("2026-10-02T10:02:00Z"));
    const explained = await canvas.show("c1", { title: "explained", html: "<p>why" });
    const diagram = await canvas.show("c1", { title: "diagram", html: "<p>how" });
    expect(ask().shownBefore).toEqual([explained.item.id, diagram.item.id]);
    expect(ask().shownBefore).toBeUndefined();
    expect(seenEarlier.item.id).not.toBe(explained.item.id);
    setSystemTime();
  });

  test("returns the answer to a waiting tool call", async () => {
    const { canvas, nextMessages, ask } = setUp();
    const item = ask();
    const answer = canvas.waitForAnswer(item, new AbortController().signal);
    canvas.answer(item.id, "Blue", " keep it subtle ");
    expect(await answer).toEqual({ label: "Blue", note: "keep it subtle" });
    expect(nextMessages).toEqual([]);
  });

  test("sends a late answer as the next message once the tool call is gone", async () => {
    const { store, canvas, nextMessages, ask } = setUp();
    const item = ask();
    const aborted = new AbortController();
    const answer = canvas.waitForAnswer(item, aborted.signal);
    aborted.abort(new Error("timeout"));
    await expect(answer).rejects.toThrow("timeout");
    canvas.answer(item.id, "Red");
    expect(nextMessages).toEqual(['My answer to your question "Color?": Red']);
    expect(asAsk(store.findCanvasItem(item.id))?.answer?.deliveredAs).toBe("next-message");
  });

  test("several questions are one item, and their answers come back together as the tool result", async () => {
    const { canvas, askSeveral, notified } = setUp();
    const item = askSeveral();
    expect(item).toMatchObject({ title: "2 questions: Color?", status: "waiting" });
    expect(notified.at(-1)).toEqual(["c1", { kind: "question", question: "2 questions: Color?" }]);
    const answer = canvas.waitForAnswer(item, new AbortController().signal);
    canvas.answer(item.id, "", undefined, [{ label: "Blue", note: " subtle " }, { label: "Huge" }]);
    const given = await answer;
    expect(given.label).toBe("Blue · Huge");
    expect(answerAsToolResult(given)).toBe(
      ["The user answered 2 questions:", "1. Color?", "   The user chose: Blue", "   Their note: subtle", "2. Size?", "   The user chose: Huge"].join("\n"),
    );
  });

  test("a note for all several answers comes after the list, in the tool result and the message", async () => {
    const { store, canvas, nextMessages, askSeveral } = setUp();
    const item = askSeveral();
    const answer = canvas.waitForAnswer(item, new AbortController().signal);
    canvas.answer(item.id, "", " Keep it short ", [{ label: "Blue" }, { label: "Huge" }]);
    const given = await answer;
    expect(asAsk(store.findCanvasItem(item.id))?.answer?.note).toBe("Keep it short");
    expect(answerAsToolResult(given)).toBe(
      ["The user answered 2 questions:", "1. Color?", "   The user chose: Blue", "2. Size?", "   The user chose: Huge", "Their note on all the answers: Keep it short"].join("\n"),
    );
    const late = askSeveral();
    canvas.answer(late.id, "", "   ", [{ label: "Red" }, { label: "Small" }]);
    expect(nextMessages.at(-1)).toBe('My answers to your questions:\n1. "Color?": Red\n2. "Size?": Small');
  });

  test("several answers sent late arrive as one next message", async () => {
    const { store, canvas, nextMessages, askSeveral } = setUp();
    const item = askSeveral();
    canvas.answer(item.id, "", undefined, [{ label: "Red" }, { label: "Small", note: "tight fit" }]);
    expect(nextMessages).toEqual(['My answers to your questions:\n1. "Color?": Red\n2. "Size?": Small\n   Note: tight fit']);
    expect(asAsk(store.findCanvasItem(item.id))?.answer).toMatchObject({ label: "Red · Small", deliveredAs: "next-message" });
  });

  test("an answer to several questions must answer each, and one question takes one answer", () => {
    const { canvas, ask, askSeveral } = setUp();
    const several = askSeveral();
    expect(() => canvas.answer(several.id, "Red")).toThrow("Answer all 2 questions");
    expect(() => canvas.answer(several.id, "", undefined, [{ label: "Red" }])).toThrow("Answer all 2 questions");
    expect(() => canvas.answer(several.id, "", undefined, [{ label: "Red" }, { label: " " }])).toThrow("Answer all 2 questions");
    expect(canvas.list("c1").find(({ id }) => id === several.id)?.status).toBe("waiting");
    expect(() => canvas.answer(ask().id, "Red", undefined, [{ label: "Red" }])).toThrow("takes one answer");
  });

  test("questionsOf gives the one question of an item that holds just one", () => {
    const { ask, askSeveral } = setUp();
    expect(questionsOf(ask())).toEqual([{ question: "Color?", options: [{ label: "Red" }, { label: "Blue" }], allowOther: false }]);
    expect(questionsOf(askSeveral()).map(({ question }) => question)).toEqual(["Color?", "Size?"]);
  });

  test("withdrawing waiting asks fails their tool calls and refuses later answers", async () => {
    const { canvas, ask } = setUp();
    const item = ask();
    const answer = canvas.waitForAnswer(item, new AbortController().signal);
    canvas.withdrawWaitingAsks("c1");
    await expect(answer).rejects.toThrow("withdrew");
    expect(() => canvas.answer(item.id, "Red")).toThrow("already answered or withdrawn");
  });

  test("does not wait for a render report when nobody is viewing", async () => {
    const { canvas } = setUp();
    const { render } = await canvas.show("c1", { title: "x", html: "<p>" });
    expect(render).toBe("no-viewer");
  });

  test("a finding the user rewords remembers what the agent wrote, however often the user rewords it", () => {
    const { store, canvas } = setUp();
    const finding = { id: "finding-1", body: "The agent's words.", decision: "keep" } as ReviewFinding;
    store.saveCanvasItem({ id: "r1", conversationId: "c1", kind: "review", title: "PR", review: { findings: [finding] } as Review, status: "shown", createdAt: 1 });
    const stored = () => asReview(store.findCanvasItem("r1"))!.findings[0]!;
    canvas.updateFinding("r1", "finding-1", { body: " The user's words. " });
    canvas.updateFinding("r1", "finding-1", { body: "The user's second words." });
    canvas.updateFinding("r1", "finding-1", { decision: "drop" });
    expect(stored()).toMatchObject({ body: "The user's second words.", agentBody: "The agent's words.", decision: "drop" });
  });

  test("each change to an item stamps when it changed, and a review a stopped host left posting counts as changed when listed", () => {
    const { store, canvas } = setUp();
    const finding = { id: "finding-1", body: "The agent's words.", decision: "keep" } as ReviewFinding;
    store.saveCanvasItem({ id: "r1", conversationId: "c1", kind: "review", title: "PR", review: { findings: [finding], posting: true } as Review, status: "shown", createdAt: 1 });
    setSystemTime(new Date(5_000));
    expect(canvas.list("c1")[0]).toMatchObject({ review: { posting: false }, updatedAt: 5_000 });
    setSystemTime(new Date(6_000));
    canvas.updateFinding("r1", "finding-1", { decision: "drop" });
    expect(store.findCanvasItem("r1")!.updatedAt).toBe(6_000);
    setSystemTime();
  });

  test("an answer the user rewords or marks to resolve remembers it, unless GitHub would not let them resolve it", () => {
    const { store, canvas } = setUp();
    const answer = (id: string, canResolve: boolean) => ({ id, body: "The agent's words.", decision: "keep", resolve: false, canResolve }) as ReviewAnswer;
    const review = { findings: [], answers: [answer("answer-1", true), answer("answer-2", false)] } as unknown as Review;
    store.saveCanvasItem({ id: "r1", conversationId: "c1", kind: "review", title: "PR", review, status: "shown", createdAt: 1 });
    canvas.updateAnswer("r1", "answer-1", { body: "The user's words.", resolve: true });
    expect(asReview(store.findCanvasItem("r1"))!.answers![0]).toMatchObject({ body: "The user's words.", agentBody: "The agent's words.", resolve: true });
    expect(() => canvas.updateAnswer("r1", "answer-2", { resolve: true })).toThrow("does not let you resolve");
  });

  test("the agent's edit changes the newest review in its own canvas item, names what changed, and keeps a choice the user made meanwhile", async () => {
    const { store, canvas } = setUp();
    const { directory } = gitRepository();
    const findings = [
      { severity: "nit" as const, checked: "confirmed" as const, at: "service.ts:2", title: "Magic number", body: "Name the 1?" },
      { severity: "issue" as const, checked: "plausible" as const, at: "service.ts:5-7", title: "Unused", body: "Is load() still needed?" },
    ];
    await canvas.review("c1", reviewRequest(directory, { findings }));
    const newest = await canvas.review("c1", reviewRequest(directory, { findings }));

    const editing = canvas.editReview("c1", { findings: [{ id: "finding-1", body: "Name it." }] });
    canvas.updateFinding(newest.id, "finding-2", { decision: "drop" });
    const { item } = await editing;

    expect(item.id).toBe(newest.id);
    expect(store.listCanvasItems("c1")).toHaveLength(2);
    expect(item.review.findings.map(({ id, body, decision }) => [id, body, decision])).toEqual([
      ["finding-1", "Name it.", "keep"],
      ["finding-2", "Is load() still needed?", "drop"],
    ]);
    expect(item.review.agentEdit).toEqual({ at: expect.any(Number), parts: ["finding-1"] });
  });

  describe("a pull request that moved on since the review", () => {
    /** GitHub, with the pull request's head, and the commit of the user's pending review if they have one, where the test puts them; every comment taken. */
    function movingPullRequest() {
      const pullRequest = { head: "", pendingReviewCommit: null as string | null };
      const gh: GitHubCli = async (args, body: any) => {
        if (args[3] === "repos/team/shop/pulls/7") return { node_id: "PR_7", head: { sha: pullRequest.head } };
        if (body.query.includes("states: PENDING")) {
          const nodes = pullRequest.pendingReviewCommit === null ? [] : [{ id: "PRR_1", url: "https://github.com/review/1", commit: { oid: pullRequest.pendingReviewCommit } }];
          return { data: { repository: { pullRequest: { reviews: { nodes } } } } };
        }
        if (body.query.includes("addPullRequestReview(")) return { data: { addPullRequestReview: { pullRequestReview: { id: "PRR_2", url: "https://github.com/review/2" } } } };
        return { data: { addPullRequestReviewThread: { thread: { id: "thread-1" } } } };
      };
      return { pullRequest, gh };
    }

    async function reviewOfPullRequest() {
      const { pullRequest, gh } = movingPullRequest();
      const setup = setUp(new Hub(), gh);
      const { directory } = gitRepository();
      const item = await setup.canvas.review("c1", reviewRequest(directory, { pullRequest: "https://github.com/team/shop/pull/7" }));
      return { ...setup, pullRequest, item, movedOn: () => asReview(setup.store.findCanvasItem(item.id))?.pullRequestMovedOn };
    }

    test("a pending review the user started on another commit is named on the review, until a post goes through once it is gone", async () => {
      const { canvas, store, pullRequest, item } = await reviewOfPullRequest();
      const posted = () => asReview(store.findCanvasItem(item.id));
      pullRequest.head = item.review.headCommit;
      pullRequest.pendingReviewCommit = "d".repeat(40);
      await canvas.postReview(item.id);
      expect(posted()?.pendingReviewOfOtherCommit).toEqual({ url: "https://github.com/review/1", commit: "d".repeat(40) });
      expect(posted()?.findings[0]?.postedAs).toBeUndefined();
      expect(posted()?.posting).toBe(false);

      pullRequest.pendingReviewCommit = null;
      await canvas.postReview(item.id);
      expect(posted()?.pendingReviewOfOtherCommit).toBeUndefined();
      expect(posted()?.pendingReviewUrl).toBe("https://github.com/review/2");
      expect(posted()?.findings[0]?.postedAs).toEqual({ threadId: "thread-1" });
    });

    test("posting says so on the review, with the new head, rather than failing", async () => {
      const { canvas, pullRequest, item, movedOn, nextMessages } = await reviewOfPullRequest();
      pullRequest.head = "f".repeat(40);
      await canvas.postReview(item.id);
      expect(movedOn()).toEqual({ headCommit: "f".repeat(40), askedToReviewAgain: false });
      expect(asReview(canvas.list("c1")[0])?.posting).toBe(false);
      expect(nextMessages).toEqual([]);
    });

    test("Review again asks the agent once, after its turn, naming the pull request and both heads; a later push lets it ask again", async () => {
      const { canvas, pullRequest, item, movedOn, nextMessages, sendOptions } = await reviewOfPullRequest();
      pullRequest.head = "a".repeat(40);
      await canvas.postReview(item.id);
      await Promise.all([canvas.reviewAgain(item.id), canvas.reviewAgain(item.id)]);
      expect(nextMessages).toEqual([
        `The pull request https://github.com/team/shop/pull/7 changed since your review: its head is ${"a".repeat(40)}, your review is of ${item.review.headCommit}. Fetch the new head and review it again with ${"a".repeat(40)} as the review's head: keep the findings that still apply, drop the ones it fixed, and add new ones.`,
      ]);
      expect(sendOptions).toEqual([{ afterTurn: true }]);
      expect(movedOn()?.askedToReviewAgain).toBe(true);

      await canvas.postReview(item.id);
      expect(movedOn()?.askedToReviewAgain).toBe(true);
      pullRequest.head = "b".repeat(40);
      await canvas.postReview(item.id);
      expect(movedOn()).toEqual({ headCommit: "b".repeat(40), askedToReviewAgain: false });
    });

    test("a post that goes through, once the head is the reviewed one again, takes the note away", async () => {
      const { canvas, pullRequest, item, movedOn } = await reviewOfPullRequest();
      pullRequest.head = "c".repeat(40);
      await canvas.postReview(item.id);
      pullRequest.head = item.review.headCommit;
      await canvas.postReview(item.id);
      expect(movedOn()).toBeUndefined();
      expect(asReview(canvas.list("c1")[0])?.findings[0]?.postedAs).toEqual({ threadId: "thread-1" });
    });

    test("Review again does nothing while the pull request is where the review left it", async () => {
      const { canvas, item, nextMessages } = await reviewOfPullRequest();
      await canvas.reviewAgain(item.id);
      expect(nextMessages).toEqual([]);
    });
  });

  test("the agent's edit names a review this conversation does not have", async () => {
    const { canvas } = setUp();
    const problems = (edit: Parameters<CanvasService["editReview"]>[1]) => canvas.editReview("c1", edit).then(() => [], (error: ReviewProblems) => error.problems);
    expect(await problems({ summary: "?" })).toEqual(["This conversation has no review to change; publish one with the review tool."]);
    expect(await problems({ review: "r9", summary: "?" })).toEqual(["review: r9 is not a review in this conversation."]);
  });

  test("a tour is a canvas item of its own, and a changed file reads as it was when the tour was published, not as it is now", async () => {
    const { store, canvas } = setUp();
    const { directory } = gitRepository();
    writeFileSync(join(directory, "service.ts"), "export function serve() {\n  return load() + 2;\n}\n");

    const item = await canvas.tour("c1", { title: "Serve", folder: directory, since: "main", summary: "Adds two.", flow: [{ title: "Entry", at: "service.ts:2", say: "Adds." }] });
    writeFileSync(join(directory, "service.ts"), "changed again\n");

    expect(store.listCanvasItems("c1").map(({ kind, title }) => [kind, title])).toEqual([["tour", "Serve"]]);
    expect(item.tour.files.map(({ path }) => path)).toEqual(["service.ts"]);
    expect(await canvas.readReviewedFile(item.id, "service.ts")).toEqual(["export function serve() {", "  return load() + 2;", "}"]);
    await expect(canvas.readReviewedFile(item.id, "other.ts")).rejects.toThrow("other.ts is not a file this tour shows changes of.");
  });
});

describe("CanvasService pages shown while nobody viewed them", () => {
  const charts = { title: "Charts", html: "<p>Charts</p>" };

  test("the errors a page's first view reports reach the agent once, with the next message", async () => {
    const { canvas } = setUp();
    const { item, render } = await canvas.show("c1", charts);
    expect(render).toBe("no-viewer");
    expect(canvas.pageErrorsNote("c1")).toBeNull();

    canvas.reportRender(item.id, { errors: ["SyntaxError: Unexpected token ']' (script 1 on the page)"] });
    const note = canvas.pageErrorsNote("c1");
    expect(note?.text).toBe(
      `The page "Charts" (canvas item ${item.id}), shown while nobody was viewing, reported errors when the user opened it:\n- SyntaxError: Unexpected token ']' (script 1 on the page)`,
    );
    expect(canvas.notesForAgent("c1").map(({ text }) => text)).toEqual([note!.text]);
    note?.heard();
    expect(canvas.pageErrorsNote("c1")).toBeNull();
    canvas.reportRender(item.id, { errors: ["seen again"] });
    expect(canvas.pageErrorsNote("c1")).toBeNull();
  });

  test("a first view without errors leaves nothing to tell, now or after", async () => {
    const { canvas } = setUp();
    const { item } = await canvas.show("c1", charts);
    canvas.reportRender(item.id, { errors: [] });
    canvas.reportRender(item.id, { errors: ["a later error"] });
    expect(canvas.notesForAgent("c1")).toEqual([]);
  });

  test("a page someone saw render as it was shown has told the agent already", async () => {
    const hub = new Hub();
    hub.isShown = () => true;
    const { canvas, store } = setUp(hub);
    const shown = canvas.show("c1", charts);
    const [item] = store.listCanvasItems("c1");
    canvas.reportRender(item!.id, { errors: ["told in the tool result"] });
    expect((await shown).render).toEqual({ errors: ["told in the tool result"] });
    canvas.reportRender(item!.id, { errors: ["a later view"] });
    expect(canvas.pageErrorsNote("c1")).toBeNull();
  });
});

describe("CanvasService checklist dismissed by the user", () => {
  const release = { title: "Release", sections: [{ items: [{ id: "tests", text: "Run the tests" }, { id: "build", text: "Build the app" }] }] };

  function dismissedAfterTicking(...tickedIds: string[]) {
    const setUpService = setUp();
    const { canvas } = setUpService;
    const { item } = canvas.publishChecklist("c1", release);
    tickedIds.forEach((id) => canvas.tickChecklistItem(item.id, id, true));
    canvas.dismissChecklist(item.id);
    return { ...setUpService, item };
  }

  test("ticks made before dismissing reach the agent once, with the next message", () => {
    const { canvas } = dismissedAfterTicking("tests", "build");
    const note = canvas.checklistNote("c1");
    expect(note?.text).toBe('On your checklist "Release", the user ticked "tests" (Run the tests), "build" (Build the app).');
    note?.heard();
    expect(canvas.checklistNote("c1")).toBeNull();
  });

  test("a dismissed checklist with nothing unheard has no note", () => {
    const { canvas } = dismissedAfterTicking();
    expect(canvas.checklistNote("c1")).toBeNull();
  });

  test("update_checklist after the dismissal says the user dismissed it, and does not invite publishing again", () => {
    const { canvas } = dismissedAfterTicking("tests");
    const error = (() => {
      try {
        canvas.editChecklist("c1", { items: [{ id: "tests", done: true }] });
      } catch (thrown) {
        return thrown as ReviewProblems;
      }
    })();
    expect(error?.message).toBe("The checklist was not changed:\n- The user dismissed this conversation's checklist; don't publish it again unless they ask for one.");
    expect(error?.message).not.toContain("call update_checklist again");
  });

  test("update_checklist in a conversation that never had a checklist still says there is none", () => {
    const { canvas } = setUp();
    expect(() => canvas.editChecklist("c1", { items: [{ id: "tests", done: true }] })).toThrow("This conversation has no checklist");
  });

  test("publishing after the dismissal starts afresh and reports the ticks the agent had not heard", () => {
    const { canvas } = dismissedAfterTicking("tests");
    const { item, replaced } = canvas.publishChecklist("c1", release);
    expect(replaced).toEqual({ title: "Release", ticks: [{ id: "tests", text: "Run the tests", done: true }] });
    expect(item.checklist.sections[0]?.items.map(({ done }) => done)).toEqual([false, false]);
    expect(canvas.checklistNote("c1")).toBeNull();
  });

  test("publishing after the dismissal reports nothing more once the note delivered the ticks", () => {
    const { canvas } = dismissedAfterTicking("tests");
    canvas.checklistNote("c1")?.heard();
    expect(canvas.publishChecklist("c1", release).replaced?.ticks).toEqual([]);
  });
});

describe("completeDirectories", () => {
  test("lists matching subdirectories and hides dotfiles unless asked", async () => {
    const root = mkdtempSync(join(tmpdir(), "mirador-paths-"));
    ["alpha", "alps", "beta", ".hidden"].forEach((name) => mkdirSync(join(root, name)));
    expect(await completeDirectories(`${root}/al`)).toEqual([`${root}/alpha/`, `${root}/alps/`]);
    expect(await completeDirectories(`${root}/`)).toEqual([`${root}/alpha/`, `${root}/alps/`, `${root}/beta/`]);
    expect(await completeDirectories(`${root}/.h`)).toEqual([`${root}/.hidden/`]);
  });
});
