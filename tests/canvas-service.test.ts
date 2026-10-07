import { describe, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationService } from "../host/conversations.ts";
import { CanvasService } from "../host/canvas/service.ts";
import { Hub } from "../host/hub.ts";
import { Store } from "../host/store.ts";
import type { SystemNotifications } from "../host/system-notifications.ts";
import type { Review, ReviewAnswer, ReviewFinding } from "../shared/review.ts";
import type { NotificationReason } from "../shared/system-notifications.ts";
import { completeDirectories } from "../host/paths.ts";
import type { ReviewProblems } from "../host/review/snapshot.ts";
import { gitRepository, reviewRequest } from "./review-repository.ts";

function setUp() {
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
    waitingFor: null,
    activity: null,
    configOptions: [],
    createdAt: 1,
    updatedAt: 1,
  });
  const nextMessages: string[] = [];
  const questionsChanged: string[] = [];
  const conversations = {
    send: async (_id: string, text: string) => void nextMessages.push(text),
    questionsChanged: (conversationId: string) => void questionsChanged.push(conversationId),
  } as unknown as ConversationService;
  const notified: [string, NotificationReason][] = [];
  const notifications = { notify: (conversationId: string, reason: NotificationReason) => void notified.push([conversationId, reason]) } as SystemNotifications;
  const canvas = new CanvasService(store, new Hub(), conversations, notifications);
  const ask = () => canvas.openAsk("c1", { question: "Color?", options: [{ label: "Red" }, { label: "Blue" }] });
  return { store, canvas, nextMessages, ask, notified, questionsChanged };
}

describe("CanvasService", () => {
  test("a question asks for a system notification", () => {
    const { ask, notified } = setUp();
    ask();
    expect(notified).toEqual([["c1", { kind: "question", question: "Color?" }]]);
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
    expect(store.findCanvasItem(item.id)?.answer?.deliveredAs).toBe("next-message");
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
    const stored = () => store.findCanvasItem("r1")!.review!.findings[0]!;
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
    expect(store.findCanvasItem("r1")!.review!.answers![0]).toMatchObject({ body: "The user's words.", agentBody: "The agent's words.", resolve: true });
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

  test("the agent's edit names a review this conversation does not have", async () => {
    const { canvas } = setUp();
    const problems = (edit: Parameters<CanvasService["editReview"]>[1]) => canvas.editReview("c1", edit).then(() => [], (error: ReviewProblems) => error.problems);
    expect(await problems({ summary: "?" })).toEqual(["This conversation has no review to change; publish one with the review tool."]);
    expect(await problems({ review: "r9", summary: "?" })).toEqual(["review: r9 is not a review in this conversation."]);
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
