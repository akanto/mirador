import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { addWorkspace, callCanvasTool, openSettings, primaryModifier, signIn, startConversation, waitForTurnToEnd, workspaceCard } from "./helpers.ts";
import { TestHost } from "./test-host.ts";

const host = new TestHost(5030, { fakePrograms: true });
const fakeProgramsDir = host.fakeProgramsDir;
const ghLog = join(host.root, "gh.log");
const ideaLog = join(host.root, "idea.log");
const PULL_REQUEST = "https://ghe.example.com/team/shop/pull/7";

const serviceBefore = `export function serve(request) {
  const user = authenticate(request);
  return load(user);
}

function authenticate(request) {
  return request.user;
}

function load(user) {
  return { user, items: [] };
}
`;
const serviceAfter = serviceBefore
  .replace("const user = authenticate(request);", "const user = authenticate(request) ?? anonymous();")
  .replace("return { user, items: [] };", "return { user, items: fetchItems(user) };");

function git(...args: string[]) {
  return execFileSync("git", ["-C", host.projectDir, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
}

/** A branch that changes service.ts and adds items.ts, like a pull request would. */
function createChange() {
  mkdirSync(host.projectDir, { recursive: true });
  git("init", "-q", "-b", "main");
  writeFileSync(join(host.projectDir, "service.ts"), serviceBefore);
  git("add", ".");
  git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "feature");
  writeFileSync(join(host.projectDir, "service.ts"), serviceAfter);
  writeFileSync(join(host.projectDir, "items.ts"), "export function fetchItems(user) {\n  return [];\n}\n");
  git("add", ".");
  git("commit", "-q", "-m", "fetch items");
  return git("rev-parse", "HEAD");
}

const comment = (id: number, author: string, body: string) => ({
  databaseId: id,
  url: `${PULL_REQUEST}#discussion_r${id}`,
  body,
  createdAt: "2026-10-01T10:00:00Z",
  author: { login: author },
});

/** Two conversations on pull 7: one the user may resolve, and an outdated one they may not. */
const conversations = {
  data: {
    repository: {
      pullRequest: {
        reviewThreads: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: "PRRT_1",
              path: "service.ts",
              line: 2,
              originalLine: 2,
              isOutdated: false,
              isResolved: false,
              viewerCanResolve: true,
              comments: { nodes: [comment(11, "reviewer", "Why the anonymous fallback?"), comment(12, "author", "Product asked for it; guarded below.")] },
            },
            {
              id: "PRRT_2",
              path: "items.ts",
              line: null,
              originalLine: 2,
              isOutdated: true,
              isResolved: false,
              viewerCanResolve: false,
              comments: { nodes: [comment(21, "reviewer", "Typo in fetchItems")] },
            },
          ],
        },
      },
    },
  },
};

/** gh and idea stand-ins that log how they were called; gh answers like GitHub for pull 7 of team/shop. */
function writeFakePrograms(head: string) {
  mkdirSync(fakeProgramsDir, { recursive: true });
  const gh = `#!/bin/bash
input=""
if [[ " $* " == *" --input - "* ]]; then input=$(cat); fi
printf '%s\\t%s\\n' "$*" "$input" >> "${ghLog}"
case "$*" in
  *"pulls/7/reviews"*) echo '[]' ;;
  *"pulls/7"*) echo '{"node_id":"PR_7","head":{"sha":"${head}"}}' ;;
  *graphql*)
    if [[ "$input" == *"reviewThreads("* ]]; then
      echo '${JSON.stringify(conversations)}'
    elif [[ "$input" == *"addPullRequestReviewThreadReply("* ]]; then
      echo '{"data":{"addPullRequestReviewThreadReply":{"comment":{"url":"${PULL_REQUEST}#discussion_r90"}}}}'
    elif [[ "$input" == *"resolveReviewThread("* ]]; then
      echo '{"data":{"resolveReviewThread":{"thread":{"isResolved":true}}}}'
    elif [[ "$input" == *"addPullRequestReview("* ]]; then
      echo '{"data":{"addPullRequestReview":{"pullRequestReview":{"id":"PRR_1","url":"${PULL_REQUEST}#pullrequestreview-1"}}}}'
    else
      echo '{"data":{"addPullRequestReviewThread":{"thread":{"id":"THREAD"}}}}'
    fi ;;
esac
`;
  const idea = `#!/bin/bash\nprintf '%s\\n' "$*" >> "${ideaLog}"\n`;
  [
    ["gh", gh],
    ["idea", idea],
  ].forEach(([name, script]) => {
    writeFileSync(join(fakeProgramsDir, name!), script!);
    chmodSync(join(fakeProgramsDir, name!), 0o755);
  });
}

const review = (change: Record<string, unknown> = {}) => ({
  title: "PR 7: fetch items for the user",
  repository: host.projectDir,
  base: "main",
  pullRequest: PULL_REQUEST,
  verdict: "Request changes: the anonymous fallback skips authentication.",
  summary: [
    "serve() now **falls back to an anonymous user** and loads the user's items through the new `fetchItems`.",
    "",
    "| Our comment | Verdict |",
    "| --- | --- |",
    "| Exception naming | fixed — renamed `OrchestratorMinionRestartRequiredExceptionThrownWhenTheSaltKeyOfAMinionWasDeletedAndItNeverComesBack` |",
  ].join("\n"),
  flow: [
    { title: "Request comes in", at: "service.ts:1-4", say: "serve() authenticates the request, then loads." },
    { title: "Items are fetched", at: "items.ts:1-3", say: "fetchItems() returns the user's items; empty for now." },
  ],
  findings: [
    { severity: "blocker", checked: "confirmed", at: "service.ts:2", title: "Anonymous fallback", body: "Is an anonymous user allowed here?", evidence: "Traced every caller of serve()." },
    { severity: "nit", checked: "plausible", at: "service.ts:7", title: "Unchanged helper", body: "Could this read the header instead?" },
    { severity: "question", checked: "plausible", at: "items.ts:2", title: "Empty items", body: "Should this call the API?" },
  ],
  ...change,
});

const canvasPane = (page: Page) => page.locator('[data-pane="canvas"]');
const logLines = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : []);

test.beforeAll(async () => {
  writeFakePrograms(createChange());
  await host.start();
});
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
});

test("a review opens full screen; the user tours the flow, moves through changes and findings, asks about lines, curates and posts the findings", async ({ page }) => {
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const conversationId = await startConversation(page);

  await test.step("wrong anchors are all sent back to the agent, and nothing is shown", async () => {
    const result = await callCanvasTool(host, conversationId, "review", review({ flow: [{ title: "Nowhere", at: "service.ts:99", say: "?" }] }));
    expect(result).toContain("The review was not shown");
    expect(result).toContain('flow step 1 ("Nowhere"): service.ts:99 is outside the file, which has 12 lines.');
    await expect(page.locator(".review")).toHaveCount(0);
  });

  const result = await callCanvasTool(host, conversationId, "review", review());
  expect(result).toContain("2 changed files, 2 flow steps and 3 findings");
  expect(result).toContain("cannot be posted as line comments: finding 2");
  const view = page.locator(".review");
  await expect(view.locator(".verdict")).toHaveText("Request changes: the anonymous fallback skips authentication.");
  await expect(canvasPane(page)).toHaveClass(/fullscreen/);

  await test.step("a wide table in the summary stays in its column, its long code wrapped", async () => {
    const table = view.locator(".overview-story table");
    const rightEdge = async (locator: Locator) => {
      const box = (await locator.boundingBox())!;
      return box.x + box.width;
    };
    for (const mode of ["Beside the chat", "Full screen"]) {
      await view.getByRole("button", { name: mode }).click();
      expect(await rightEdge(table)).toBeLessThanOrEqual(await rightEdge(view.locator(".overview-story")));
      expect(await table.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    }
  });

  await test.step("a long verdict in the canvas bar gives way to the title and the bar's buttons", async () => {
    await view.getByRole("button", { name: "Beside the chat" }).click();
    const bar = canvasPane(page).locator(".canvas-header");
    const fullyShown = (locator: Locator) =>
      locator.evaluate((element) => {
        const text = document.createRange();
        text.selectNodeContents(element);
        return text.getBoundingClientRect().width <= element.getBoundingClientRect().width;
      });
    const rightEdge = async (locator: Locator) => {
      const box = (await locator.boundingBox())!;
      return box.x + box.width;
    };
    expect(await fullyShown(bar.locator(".canvas-title"))).toBe(true);
    expect(await rightEdge(bar.getByRole("button", { name: "Hide" }))).toBeLessThanOrEqual(await rightEdge(bar));
    await expect(bar.locator(".canvas-outcome")).toHaveAttribute("title", "Request changes: the anonymous fallback skips authentication.");
    await view.getByRole("button", { name: "Full screen" }).click();
  });

  await test.step("the bar's button puts the review beside the chat and back", async () => {
    await view.getByRole("button", { name: "Beside the chat" }).click();
    await expect(canvasPane(page)).not.toHaveClass(/fullscreen/);
    await view.getByRole("button", { name: "Full screen" }).click();
    await expect(canvasPane(page)).toHaveClass(/fullscreen/);
  });

  await test.step("the flow tour steps through the code with the anchored lines marked", async () => {
    await view.getByRole("tab", { name: /Flow/ }).click();
    await expect(view.locator(".flow-step h3")).toHaveText("Request comes in");
    await expect(view.locator(".code-row.anchored")).toHaveCount(4);
    await expect(view.locator(".code-row.removed")).toHaveText([/const user = authenticate\(request\);$/]);
    await page.keyboard.press("o");
    await expect.poll(() => logLines(ideaLog).at(-1)).toMatch(/^--line 1 \/.*\/service\.ts$/);
    await page.keyboard.press("ArrowRight");
    await expect(view.locator(".flow-step h3")).toHaveText("Items are fetched");
  });

  await test.step("files come in tour order, and n jumps to the next finding on its line in the diff", async () => {
    await page.keyboard.press("3");
    await expect(view.locator(".review-list .file-name")).toHaveText(["service.ts", "items.ts"]);
    await page.keyboard.press("n");
    await expect(view.locator(".finding.selected .finding-title")).toHaveText("Unchanged helper");
    await expect(view.locator(".findings-elsewhere .finding")).toHaveCount(1);
    await page.keyboard.press("p");
    await expect(view.locator(".finding.selected .finding-title")).toHaveText("Anonymous fallback");
    await expect(view.locator(".code-block .finding.selected")).toHaveCount(1);
  });

  await test.step("the lines the diff leaves out between two changes can be shown, and the code is highlighted", async () => {
    const between = view.locator(".hunk").nth(1).locator(".hunk-header");
    await expect(view.getByRole("button", { name: "Show the rest of the file" })).toBeVisible();
    await between.getByRole("button", { name: "Show 2 lines" }).click();
    await expect(view.locator(".hunk").first().getByRole("button", { name: /^Line [67]$/ })).toHaveCount(2);
    await expect(between.getByRole("button")).toHaveCount(0);
    await expect(view.getByRole("button", { name: "Show the rest of the file" })).toHaveCount(0);
    await expect(view.locator(".code-row .token.keyword").first()).toHaveText("export");
    await expect(view.locator(".code-block .finding", { hasText: "Unchanged helper" })).toBeVisible();
    await expect(view.locator(".findings-elsewhere")).toHaveCount(0);
    await page.keyboard.press("2");
    await expect(view.locator(".flow-step h3")).toBeVisible();
    await page.keyboard.press("3");
    await expect(view.locator(".hunk").first().getByRole("button", { name: /^Line [67]$/ })).toHaveCount(2);
  });

  await test.step("selected lines go to the agent as a question, with their code, and the primary key with Enter asks it to update the review too", async () => {
    const firstHunk = view.locator(".hunk").first();
    await firstHunk.locator(".code-row.added .line-number").click();
    await firstHunk.getByRole("button", { name: "Line 4", exact: true }).click({ modifiers: ["Shift"] });
    await expect(view.locator(".selection-label")).toHaveText("service.ts:2-4");
    await page.keyboard.press("o");
    await expect.poll(() => logLines(ideaLog).at(-1)).toMatch(/^--line 2 \/.*\/service\.ts$/);
    await page.keyboard.press("a");
    const question = page.getByRole("dialog", { name: "Ask the agent about these lines" }).locator("textarea");
    await expect(page.getByRole("button", { name: "Ask and update the review" })).toBeDisabled();
    await question.fill("Reply with just the word NOTED.");
    await question.press(`${await primaryModifier(page)}+Enter`);
    await expect(view.locator(".review-sent")).toContainText("Asked about service.ts:2-4");
    await expect(view.locator(".review-sent")).toContainText("publishes the review again if the answer changes it");
    await view.getByRole("button", { name: "Show the chat" }).click();
    await expect(canvasPane(page)).not.toHaveClass(/fullscreen/);
    const asked = page.locator(".message.user").last();
    await expect(asked).toContainText('About service.ts:2-4 in the review "PR 7: fetch items for the user"');
    await expect(asked).toContainText("+  const user = authenticate(request) ?? anonymous();");
    await expect(asked).toContainText("publish the review again with the review tool");
  });

  await test.step("kept and edited findings on the diff go to a pending review; the one outside the diff stays", async () => {
    await view.getByRole("tab", { name: /Findings/ }).click();
    const finding = (title: string) => view.locator(".finding", { hasText: title });
    await expect(finding("Unchanged helper")).toContainText("Outside the pull request's diff");
    await finding("Unchanged helper").getByRole("button", { name: "Kept" }).click();
    await expect(finding("Unchanged helper").getByRole("button", { name: "Dropped" })).toBeVisible();
    await expect(view.getByRole("tab", { name: /Findings/ }).locator(".tab-count")).toHaveText("2");
    await finding("Empty items").getByRole("button", { name: "Edit" }).click();
    await finding("Empty items").locator("textarea").fill("Should this call the items API?");
    await finding("Empty items").getByRole("button", { name: "Save" }).click();
    await expect(finding("Empty items")).toContainText("Should this call the items API?");

    await view.getByRole("button", { name: "Post 2 findings to the pull request" }).click();
    await expect(view.locator(".posted-note").first()).toContainText("2 findings are on your pending review");
    await expect(finding("Anonymous fallback")).toContainText("On the pull request");
    await expect(finding("Anonymous fallback").getByRole("button", { name: "Edit" })).toBeDisabled();
    const calls = logLines(ghLog);
    expect(calls.every((line) => line.startsWith("api --hostname ghe.example.com "))).toBe(true);
    const bodies = calls.flatMap((line) => (line.split("\t")[1] ? [JSON.parse(line.split("\t")[1]!)] : []));
    expect(bodies.map(({ variables }) => variables.input)).toEqual([
      { pullRequestId: "PR_7", commitOID: git("rev-parse", "HEAD") },
      { pullRequestReviewId: "PRR_1", path: "service.ts", line: 2, side: "RIGHT", body: "Is an anonymous user allowed here?" },
      { pullRequestReviewId: "PRR_1", path: "items.ts", line: 2, side: "RIGHT", body: "Should this call the items API?" },
    ]);
  });

  await test.step("published again with a comment reworded, the review keeps what the user dropped and posted", async () => {
    const [fallback, helper, emptyItems] = review().findings;
    const again = await callCanvasTool(
      host,
      conversationId,
      "review",
      review({
        findings: [
          fallback,
          { ...helper, body: "Could this read the request header instead?" },
          emptyItems,
          { severity: "nit", checked: "plausible", at: "items.ts:1", title: "Return type", body: "Worth typing the items?" },
        ],
      }),
    );
    expect(again).toContain("Dropped by the user: finding 2.");
    expect(again).toContain("Already on the pull request as posted, so change those there: finding 1, finding 3.");
    await view.getByRole("tab", { name: /Findings/ }).click();
    const finding = (title: string) => view.locator(".finding", { hasText: title });
    await expect(finding("Unchanged helper")).toContainText("Could this read the request header instead?");
    await expect(finding("Unchanged helper").getByRole("button", { name: "Dropped" })).toBeVisible();
    await expect(finding("Empty items")).toContainText("Should this call the items API?");
    await expect(finding("Empty items")).toContainText("On the pull request");
    await expect(finding("Anonymous fallback")).toContainText("On the pull request");
    await expect(view.getByRole("button", { name: "Post 1 finding to the pull request" })).toBeVisible();
  });

  await test.step("with Settings set to open reviews beside the chat, the next review leaves the chat in view", async () => {
    await waitForTurnToEnd(page);
    const settings = await openSettings(page);
    await settings.getByLabel("Open reviews").selectOption({ label: "In the canvas pane, beside the chat" });
    await settings.getByRole("button", { name: "Close" }).click();
    await callCanvasTool(host, conversationId, "review", review({ title: "Second look", pullRequest: undefined, findings: [] }));
    await expect(page.locator(".canvas-title")).toHaveText("Second look");
    await expect(view.locator(".verdict")).toBeVisible();
    await expect(canvasPane(page)).not.toHaveClass(/fullscreen/);
  });
});

test("a re-review answers the pull request's conversations; the user resolves one, rewords the other, and posts both as replies", async ({ page }) => {
  await signIn(page, host);
  const addProject = page.getByRole("button", { name: "+ Add a project directory" });
  await expect(addProject.or(workspaceCard(page, host.projectDir))).toBeVisible();
  if (await addProject.isVisible()) await addWorkspace(page, host.projectDir);
  const conversationId = await startConversation(page);
  const view = page.locator(".review");

  await test.step("an answer to a conversation that is not on the pull request is sent back to the agent, and nothing is shown", async () => {
    const result = await callCanvasTool(host, conversationId, "review", review({ findings: [], answers: [{ conversation: `${PULL_REQUEST}#discussion_r99`, body: "?" }] }));
    expect(result).toContain(`answer 1: "${PULL_REQUEST}#discussion_r99" is not a conversation on ${PULL_REQUEST}`);
    await expect(view).toHaveCount(0);
  });

  const answers = [
    { conversation: `${PULL_REQUEST}#discussion_r12`, body: "Thanks, the guard below covers it.", resolve: true },
    { conversation: "PRRT_2", body: "Still there." },
  ];
  expect(await callCanvasTool(host, conversationId, "review", review({ findings: [], answers }))).toContain("2 answers to conversations");
  const fallback = view.locator(".answer", { hasText: "Why the anonymous fallback?" });
  const typo = view.locator(".answer", { hasText: "Typo in fetchItems" });

  await test.step("the overview lists the conversations answered; each shows its comments as GitHub has them, and the draft answer", async () => {
    await view.getByRole("button", { name: "Why the anonymous fallback?" }).click();
    await expect(view.getByRole("tab", { name: /Conversations/ })).toHaveAttribute("aria-selected", "true");
    await expect(fallback.locator(".conversation-comments li")).toHaveText([/^reviewer\s*Why the anonymous fallback\?$/, /^author\s*Product asked for it; guarded below\.$/]);
    await expect(fallback.locator(".answer-body")).toContainText("Thanks, the guard below covers it.");
    await expect(fallback.getByLabel("Resolve when posted (the agent suggests it)")).not.toBeChecked();
    await expect(typo.locator(".conversation-state")).toHaveText("Outdated");
    await expect(typo.locator(".anchor")).toHaveText("items.ts:2");
    await expect(typo.getByLabel("Resolve when posted")).toBeDisabled();
  });

  await test.step("the user resolves one and rewords the other; posting replies on the pending review and resolves the one", async () => {
    const callsBefore = logLines(ghLog).length;
    await fallback.getByLabel(/Resolve when posted/).click();
    await expect(fallback.getByLabel(/Resolve when posted/)).toBeChecked();
    await expect(view.locator(".post-panel")).toContainText("1 conversation is resolved as you post");
    await typo.getByRole("button", { name: "Edit" }).click();
    await typo.locator("textarea").fill("Still there, in fetchItems.");
    await typo.getByRole("button", { name: "Save" }).click();
    await view.getByRole("button", { name: "Post 2 answers to the pull request" }).click();
    await expect(fallback).toContainText("On your pending review, conversation resolved");
    await expect(typo).toContainText("On your pending review");
    await expect(view.locator(".posted-note")).toContainText("2 answers are on your pending review");
    const bodies = logLines(ghLog)
      .slice(callsBefore)
      .flatMap((line) => (line.split("\t")[1] ? [JSON.parse(line.split("\t")[1]!)] : []));
    expect(bodies.map(({ variables }) => variables.input)).toEqual([
      { pullRequestId: "PR_7", commitOID: git("rev-parse", "HEAD") },
      { pullRequestReviewId: "PRR_1", pullRequestReviewThreadId: "PRRT_1", body: "Thanks, the guard below covers it." },
      { threadId: "PRRT_1" },
      { pullRequestReviewId: "PRR_1", pullRequestReviewThreadId: "PRRT_2", body: "Still there, in fetchItems." },
    ]);
  });
});
