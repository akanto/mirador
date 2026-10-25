import { describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeSessionMeta } from "../host/acp/harnesses.ts";
import { canvasInstructions, canvasUseGuidance } from "../host/canvas/guidance.ts";
import type { GitHubCli } from "../host/review/github.ts";
import { pluginItemOfSavedWalkthrough, type SavedReview, type SavedTour } from "../host/saved-walkthroughs.ts";
import { Store } from "../host/store.ts";
import type { CanvasItem, PluginCanvasItem } from "../shared/model.ts";
import { verdictInBrief, type Review, type ReviewAnswer, type ReviewFinding, type Tour } from "../shared/review.ts";
import type { PlaceInWalkthrough } from "../shared/walkthrough-actions.ts";
import { canvasPluginHost, storeWithConversation } from "./canvas-plugin-host.ts";
import { codeReviewPlugin } from "../plugins/review/host.ts";
import { gitRepository, reviewRequest } from "./review-repository.ts";

const SHIPPED = join(import.meta.dir, "..", "plugins");
const NO_PLUGINS_OF_THE_OWNER = join(tmpdir(), "mirador-no-plugins-here");

const NO_GH: GitHubCli = async () => {
  throw new Error("No gh in this test.");
};

const setUp = (store?: Store, gh = NO_GH) => canvasPluginHost(NO_PLUGINS_OF_THE_OWNER, SHIPPED, store, { review: codeReviewPlugin(gh) });

const place = (tab: PlaceInWalkthrough["tab"]): PlaceInWalkthrough => ({ tab, stepIndex: 1, path: null, hunkIndex: 0, findingId: null, answerId: null, scrolled: {} });

describe("the review plugin Mirador comes with: tours", () => {
  test("the tour tool is pre-allowed and offered up front, with its lines of guidance", async () => {
    const { plugins, mcpRequest } = await setUp();
    const { tools } = await mcpRequest("tools/list", {});
    expect(tools.find(({ name }: { name: string }) => name === "tour")).toMatchObject({ _meta: { "anthropic/alwaysLoad": true } });
    expect(claudeSessionMeta("often", { canvasPlugins: plugins.guidance }).claudeCode.options.allowedTools).toContain("mcp__canvas__tour");
    expect(canvasInstructions("http://127.0.0.1:4601", plugins.guidance)).toContain("\n- tour: when you explain how code works,");
    expect(canvasUseGuidance(plugins.guidance)).toContain("\n- tour: explaining how code works,");
  });

  test("a tour is the plugin's item, and a changed file reads as it was when the tour was published, not as it is now", async () => {
    const { callTool, items, plugins } = await setUp();
    const { directory } = gitRepository();
    writeFileSync(join(directory, "service.ts"), "export function serve() {\n  return load() + 2;\n}\n");

    const shown = await callTool("tour", { title: "Serve", folder: directory, since: "main", summary: "Adds two.", flow: [{ title: "Entry", at: "service.ts:2", say: "Adds." }] });
    writeFileSync(join(directory, "service.ts"), "changed again\n");

    const [tour] = items();
    expect(shown).toEqual({ text: `Shown to the user as tour ${tour!.id}: 1 flow steps, 1 files changed since main.`, isError: false });
    expect(tour).toMatchObject({ kind: "plugin", plugin: "review", type: "tour", icon: "↯", placement: "page", title: "Serve" });
    expect((tour!.data as Tour).files.map(({ path }) => path)).toEqual(["service.ts"]);
    expect(await plugins.act(tour!.id, { kind: "read-file", path: "service.ts" })).toEqual(["export function serve() {", "  return load() + 2;", "}"]);
    await expect(plugins.act(tour!.id, { kind: "read-file", path: "other.ts" })).rejects.toThrow("other.ts is not a file this tour shows changes of.");
  });

  test("wrong anchors all go back to the agent, and nothing is shown", async () => {
    const { callTool, items } = await setUp();
    const { directory } = gitRepository();
    const refused = await callTool("tour", { title: "Nowhere", folder: directory, summary: "?", flow: [{ title: "Nowhere", at: "service.ts:99", say: "?" }] });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("The tour was not shown.");
    expect(refused.text).toContain("service.ts:99 is outside the file");
    expect(items()).toEqual([]);
  });

  test("the view's pane shares and the place left in each tour are kept", async () => {
    const { callTool, plugins, items } = await setUp();
    const { directory } = gitRepository();
    const tour = { title: "Serve", folder: directory, summary: "s", flow: [{ title: "Entry", at: "service.ts:2", say: "Adds." }] };
    await callTool("tour", tour);
    await callTool("tour", tour);
    const [first, second] = items();
    expect(await plugins.act(first!.id, { kind: "recall" })).toEqual({ paneShares: null, place: null });

    await plugins.act(first!.id, { kind: "remember-pane-shares", shares: { listShare: 0.3, bandShare: 0.4 } });
    await plugins.act(first!.id, { kind: "leave-place", place: place("flow") });
    await plugins.act(second!.id, { kind: "leave-place", place: place("files") });
    expect(await plugins.act(first!.id, { kind: "recall" })).toEqual({ paneShares: { listShare: 0.3, bandShare: 0.4 }, place: place("flow") });
    expect(await plugins.act(second!.id, { kind: "recall" })).toMatchObject({ place: { tab: "files" } });

  });
});

const savedTour: SavedTour = {
  id: "saved-tour",
  conversationId: "c1",
  kind: "tour",
  title: "How it serves",
  status: "shown",
  createdAt: 5,
  tour: { folder: "/tmp/p", changes: null, summary: "Serves.", flow: [{ title: "Entry", at: { path: "a.ts", line: 1, endLine: 1 }, say: "Starts.", excerpt: [] }], files: [] } as unknown as Tour,
};

describe("a review's verdict in brief, as the canvas bar shows it", () => {
  test("is its first words, before the reason after a colon or a dash", () => {
    expect(verdictInBrief('Request changes: "Not recommended" is read as the recommended option.')).toBe("Request changes");
    expect(verdictInBrief("Approve — a small, correct CSS fix.")).toBe("Approve");
    expect(verdictInBrief("Approve.")).toBe("Approve.");
    expect(verdictInBrief(": nothing before the colon")).toBe(": nothing before the colon");
  });
});

describe("tours saved before tours came from the review plugin", () => {
  test("become the plugin's items, as they were, changed now", () => {
    expect(pluginItemOfSavedWalkthrough(savedTour, 100)).toEqual({
      id: "saved-tour",
      conversationId: "c1",
      kind: "plugin",
      plugin: "review",
      type: "tour",
      icon: "↯",
      placement: "page",
      title: "How it serves",
      status: "shown",
      createdAt: 5,
      updatedAt: 100,
      data: savedTour.tour,
    });
  });

  test("are handed to the plugin when Mirador opens its database", () => {
    const path = join(mkdtempSync(join(tmpdir(), "saved-tours-")), "state.sqlite");
    const before = storeWithConversation(path);
    before.saveCanvasItem(savedTour as unknown as CanvasItem);
    before.close();
    const opened = new Store(path);
    expect(opened.listCanvasItems("c1") as PluginCanvasItem[]).toMatchObject([{ id: "saved-tour", kind: "plugin", plugin: "review", type: "tour", data: savedTour.tour }]);
  });
});

/** A review the plugin published in c1, as its item. */
function savedReview(store: Store, review: Partial<Review>, id = "r1") {
  const item: PluginCanvasItem = { id, conversationId: "c1", kind: "plugin", plugin: "review", type: "review", icon: "⇄", placement: "page", title: "PR", data: review, status: "shown", createdAt: 1 };
  store.saveCanvasItem(item);
  return item;
}

const reviewOf = (item: CanvasItem | undefined) => (item as PluginCanvasItem | undefined)?.data as Review | undefined;

describe("the review plugin Mirador comes with: reviews", () => {
  test("review and update_review are pre-allowed and offered up front, with their lines of guidance after the checklist's", async () => {
    const { plugins, mcpRequest } = await setUp();
    const { tools } = await mcpRequest("tools/list", {});
    for (const name of ["review", "update_review"]) {
      expect(tools.find((tool: { name: string }) => tool.name === name)).toMatchObject({ _meta: { "anthropic/alwaysLoad": true } });
      expect(claudeSessionMeta("often", { canvasPlugins: plugins.guidance }).claudeCode.options.allowedTools).toContain(`mcp__canvas__${name}`);
    }
    expect(canvasInstructions("http://127.0.0.1:4601", plugins.guidance)).toContain(
      "or in update_checklist's result.\n- review: when you review code changes (a pull request or a branch),",
    );
    expect(canvasInstructions("http://127.0.0.1:4601", plugins.guidance)).toContain("only when the code under review changed.\n- tour: when you explain how code works,");
  });

  test("a review is the plugin's item that opens with room, its verdict its outcome, and the agent hears the ids to change it by", async () => {
    const { callTool, items, plugins } = await setUp();
    const { directory } = gitRepository();
    const shown = await callTool("review", reviewRequest(directory));
    const [review] = items();
    expect(review).toMatchObject({ plugin: "review", type: "review", icon: "⇄", placement: "page", title: "Serve one more", outcome: "Approve.", opensWithRoom: true });
    expect(shown).toEqual({
      text: `Shown to the user as review ${review!.id}: 1 changed files, 1 flow steps and 1 findings. To change parts of it later, call update_review with these ids: finding-1 "Magic number" at service.ts:2.`,
      isError: false,
    });
    expect(await plugins.act(review!.id, { kind: "read-file", path: "service.ts" })).toContain("export function serve() {");
    expect(await plugins.act(review!.id, { kind: "check-github-cli" })).toBeNull();
  });

  test("a finding the user rewords remembers what the agent wrote, however often the user rewords it", async () => {
    const { store, plugins } = await setUp();
    savedReview(store, { findings: [{ id: "finding-1", body: "The agent's words.", decision: "keep" } as ReviewFinding] });
    await plugins.act("r1", { kind: "update-finding", findingId: "finding-1", body: " The user's words. " });
    await plugins.act("r1", { kind: "update-finding", findingId: "finding-1", body: "The user's second words." });
    await plugins.act("r1", { kind: "update-finding", findingId: "finding-1", decision: "drop" });
    expect(reviewOf(store.findCanvasItem("r1"))!.findings[0]).toMatchObject({ body: "The user's second words.", agentBody: "The agent's words.", decision: "drop" });
    expect(store.findCanvasItem("r1")).not.toHaveProperty("agentEditedAt");
  });

  test("a review a stopped host left posting is listed as not posting, and counts as changed", async () => {
    const { store, plugins } = await setUp();
    const item = savedReview(store, { findings: [], posting: true });
    setSystemTime(new Date(5_000));
    expect(plugins.listed(item)).toMatchObject({ data: { posting: false }, updatedAt: 5_000 });
    setSystemTime();
  });

  test("an answer the user rewords or marks to resolve remembers it, unless GitHub would not let them resolve it", async () => {
    const { store, plugins } = await setUp();
    const answer = (id: string, canResolve: boolean) => ({ id, body: "The agent's words.", decision: "keep", resolve: false, canResolve }) as ReviewAnswer;
    savedReview(store, { findings: [], answers: [answer("answer-1", true), answer("answer-2", false)] });
    await plugins.act("r1", { kind: "update-answer", answerId: "answer-1", body: "The user's words.", resolve: true });
    expect(reviewOf(store.findCanvasItem("r1"))!.answers![0]).toMatchObject({ body: "The user's words.", agentBody: "The agent's words.", resolve: true });
    await expect(plugins.act("r1", { kind: "update-answer", answerId: "answer-2", resolve: true })).rejects.toThrow("does not let you resolve");
  });

  test("a tour takes none of a review's actions", async () => {
    const { callTool, items, plugins } = await setUp();
    const { directory } = gitRepository();
    await callTool("tour", { title: "Serve", folder: directory, summary: "s", flow: [{ title: "Entry", at: "service.ts:2", say: "Adds." }] });
    await expect(plugins.act(items()[0]!.id, { kind: "post" })).rejects.toThrow("Only a review takes that action.");
  });

  test("the agent's edit changes the newest review in its own canvas item, names what changed, and keeps a choice the user made meanwhile", async () => {
    const { callTool, items, plugins } = await setUp();
    const { directory } = gitRepository();
    const findings = [
      { severity: "nit" as const, checked: "confirmed" as const, at: "service.ts:2", title: "Magic number", body: "Name the 1?" },
      { severity: "issue" as const, checked: "plausible" as const, at: "service.ts:5-7", title: "Unused", body: "Is load() still needed?" },
    ];
    await callTool("review", reviewRequest(directory, { findings }));
    await callTool("review", reviewRequest(directory, { findings }));
    const newest = items()[1]!;

    const editing = callTool("update_review", { findings: [{ id: "finding-1", body: "Name it." }] });
    await plugins.act(newest.id, { kind: "update-finding", findingId: "finding-2", decision: "drop" });
    expect((await editing).text).toBe(`In review ${newest.id}, updated finding-1 in place; the user sees the change where they are in the review.`);

    expect(items()).toHaveLength(2);
    const edited = items()[1]!;
    expect(reviewOf(edited)!.findings.map(({ id, body, decision }) => [id, body, decision])).toEqual([
      ["finding-1", "Name it.", "keep"],
      ["finding-2", "Is load() still needed?", "drop"],
    ]);
    expect(reviewOf(edited)!.agentEdit).toEqual({ at: expect.any(Number), parts: ["finding-1"] });
    expect(edited.agentEditedAt).toEqual(expect.any(Number));
  });

  test("the agent's edit names a review this conversation does not have", async () => {
    const { callTool } = await setUp();
    expect(await callTool("update_review", { summary: "?" })).toEqual({
      text: "The review was not changed. Fix these and call update_review again:\n- This conversation has no review to change; publish one with the review tool.",
      isError: true,
    });
    expect((await callTool("update_review", { review: "r9", summary: "?" })).text).toContain("- review: r9 is not a review in this conversation.");
  });

  /** GitHub, with the pull request's head, and the commit of the user's pending review if they have one, where the test puts them; every comment taken. */
  function movingPullRequest() {
    const pullRequest = { head: "", pendingReviewCommit: null as string | null, unreachable: false, answered: Promise.resolve(), threadsAdded: 0 };
    const gh: GitHubCli = async (args, body: any) => {
      await pullRequest.answered;
      if (pullRequest.unreachable) throw new Error("error connecting to api.github.com");
      if (args[3] === "repos/team/shop/pulls/7") return { node_id: "PR_7", head: { sha: pullRequest.head } };
      if (body.query.includes("states: PENDING")) {
        const nodes = pullRequest.pendingReviewCommit === null ? [] : [{ id: "PRR_1", url: "https://github.com/review/1", commit: { oid: pullRequest.pendingReviewCommit } }];
        return { data: { repository: { pullRequest: { reviews: { nodes } } } } };
      }
      if (body.query.includes("addPullRequestReview(")) return { data: { addPullRequestReview: { pullRequestReview: { id: "PRR_2", url: "https://github.com/review/2" } } } };
      pullRequest.threadsAdded++;
    return { data: { addPullRequestReviewThread: { thread: { id: "thread-1" } } } };
    };
    return { pullRequest, gh };
  }

  async function reviewOfPullRequest() {
    const { pullRequest, gh } = movingPullRequest();
    const setup = await setUp(undefined, gh);
    const { directory } = gitRepository();
    await setup.callTool("review", reviewRequest(directory, { pullRequest: "https://github.com/team/shop/pull/7" }));
    const item = setup.items()[0]!;
    const review = () => reviewOf(setup.store.findCanvasItem(item.id))!;
    const act = (action: Record<string, unknown>) => setup.plugins.act(item.id, action);
    const post = async () => {
      await act({ kind: "post" });
      while (review().posting) await Bun.sleep(1);
    };
    return { ...setup, pullRequest, item, headCommit: review().headCommit, review, act, post, movedOn: () => review().pullRequestMovedOn };
  }

  describe("a pull request that moved on since the review", () => {
    test("a pending review the user started on another commit is named on the review, until a post goes through once it is gone", async () => {
      const { pullRequest, headCommit, review, post } = await reviewOfPullRequest();
      pullRequest.head = headCommit;
      pullRequest.pendingReviewCommit = "d".repeat(40);
      await post();
      expect(review().pendingReviewOfOtherCommit).toEqual({ url: "https://github.com/review/1", commit: "d".repeat(40) });
      expect(review().findings[0]?.postedAs).toBeUndefined();
      expect(review().posting).toBe(false);

      pullRequest.pendingReviewCommit = null;
      await post();
      expect(review().pendingReviewOfOtherCommit).toBeUndefined();
      expect(review().pendingReviewUrl).toBe("https://github.com/review/2");
      expect(review().findings[0]?.postedAs).toEqual({ threadId: "thread-1" });
    });

    test("posting says so on the review, with the new head, rather than failing", async () => {
      const { pullRequest, post, movedOn, review, prompts } = await reviewOfPullRequest();
      pullRequest.head = "f".repeat(40);
      await post();
      expect(movedOn()).toEqual({ headCommit: "f".repeat(40), askedToReviewAgain: false });
      expect(review().posting).toBe(false);
      expect(prompts).toEqual([]);
    });

    test("Review again asks the agent once, after its turn, naming the pull request and both heads; a later push lets it ask again", async () => {
      const { pullRequest, headCommit, act, post, movedOn, prompts } = await reviewOfPullRequest();
      pullRequest.head = "a".repeat(40);
      await post();
      await Promise.all([act({ kind: "review-again" }), act({ kind: "review-again" })]);
      expect(prompts).toEqual([
        {
          conversationId: "c1",
          text: `The pull request https://github.com/team/shop/pull/7 changed since your review: its head is ${"a".repeat(40)}, your review is of ${headCommit}. Fetch the new head and review it again with ${"a".repeat(40)} as the review's head: keep the findings that still apply, drop the ones it fixed, and add new ones.`,
          afterTurn: true,
        },
      ]);
      expect(movedOn()?.askedToReviewAgain).toBe(true);

      await post();
      expect(movedOn()?.askedToReviewAgain).toBe(true);
      pullRequest.head = "b".repeat(40);
      await post();
      expect(movedOn()).toEqual({ headCommit: "b".repeat(40), askedToReviewAgain: false });
    });

    test("Review again that couldn't reach the agent can be asked again", async () => {
      const { pullRequest, act, post, movedOn, plugins } = await reviewOfPullRequest();
      pullRequest.head = "a".repeat(40);
      await post();
      plugins.sendsPromptsWith(async () => {
        throw new Error("The conversation is gone.");
      });
      await expect(act({ kind: "review-again" })).rejects.toThrow("The conversation is gone.");
      expect(movedOn()?.askedToReviewAgain).toBe(false);
    });

    test("a post that goes through, once the head is the reviewed one again, takes the note away", async () => {
      const { pullRequest, headCommit, post, movedOn, review } = await reviewOfPullRequest();
      pullRequest.head = "c".repeat(40);
      await post();
      pullRequest.head = headCommit;
      await post();
      expect(movedOn()).toBeUndefined();
      expect(review().findings[0]?.postedAs).toEqual({ threadId: "thread-1" });
    });

    test("Review again does nothing while the pull request is where the review left it", async () => {
      const { act, prompts } = await reviewOfPullRequest();
      await act({ kind: "review-again" });
      expect(prompts).toEqual([]);
    });
  });

  describe("posting", () => {
    test("Post answers as soon as posting starts, however long GitHub takes, and a second Post meanwhile posts nothing more", async () => {
      const { pullRequest, headCommit, review, act, post } = await reviewOfPullRequest();
      pullRequest.head = headCommit;
      const github = Promise.withResolvers<void>();
      pullRequest.answered = github.promise;
      await act({ kind: "post" });
      expect(review().posting).toBe(true);
      await act({ kind: "post" });

      github.resolve();
      await post();
      expect(review().findings[0]?.postedAs).toEqual({ threadId: "thread-1" });
      expect(review().pendingReviewUrl).toBe("https://github.com/review/2");
      expect(pullRequest.threadsAdded).toBe(1);
    });

    test("a post that fails as a whole says why on the review, until the user posts again", async () => {
      const { pullRequest, headCommit, review, post } = await reviewOfPullRequest();
      pullRequest.head = headCommit;
      pullRequest.unreachable = true;
      await post();
      expect(review().postFailure).toBe("error connecting to api.github.com");
      expect(review().findings[0]?.postedAs).toBeUndefined();

      pullRequest.unreachable = false;
      await post();
      expect(review().postFailure).toBeUndefined();
      expect(review().findings[0]?.postedAs).toEqual({ threadId: "thread-1" });
    });
  });
});

const savedReviewRow: SavedReview = {
  id: "saved-review",
  conversationId: "c1",
  kind: "review",
  title: "PR 7",
  status: "shown",
  createdAt: 5,
  review: { verdict: "Request changes.", findings: [], posting: true } as unknown as Review,
};

describe("reviews saved before reviews came from the review plugin", () => {
  test("become the plugin's items that open with room, with their verdict, not posting, changed now", () => {
    expect(pluginItemOfSavedWalkthrough(savedReviewRow, 100)).toEqual({
      id: "saved-review",
      conversationId: "c1",
      kind: "plugin",
      plugin: "review",
      type: "review",
      icon: "⇄",
      placement: "page",
      title: "PR 7",
      status: "shown",
      createdAt: 5,
      updatedAt: 100,
      data: { ...savedReviewRow.review, posting: false },
      outcome: "Request changes.",
      opensWithRoom: true,
    });
  });

  test("are handed to the plugin when Mirador opens its database, with the tours", () => {
    const path = join(mkdtempSync(join(tmpdir(), "saved-reviews-")), "state.sqlite");
    const before = storeWithConversation(path);
    before.saveCanvasItem(savedReviewRow as unknown as CanvasItem);
    before.saveCanvasItem(savedTour as unknown as CanvasItem);
    before.close();
    const opened = new Store(path);
    expect(opened.listCanvasItems("c1") as PluginCanvasItem[]).toMatchObject([
      { id: "saved-review", kind: "plugin", type: "review", outcome: "Request changes." },
      { id: "saved-tour", kind: "plugin", type: "tour" },
    ]);
  });
});
