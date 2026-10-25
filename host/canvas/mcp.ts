import { createMcpHandler, McpServer, type McpHttpHandler, type ServerContext } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { ConversationService } from "../conversations.ts";
import { CANVAS_SERVER_NAME } from "../acp/harnesses.ts";
import { JobWaitRefused, jobWaitToolDescription } from "../job-waits.ts";
import { canvasInstructions, NO_CANVAS_PLUGINS } from "./guidance.ts";
import type { CanvasPlugins } from "./plugins.ts";
import { readJobWaitRequest, waitSetUpReply } from "../../shared/job-waits.ts";
import { answerAsToolResult, type CanvasService, type RenderOutcome } from "./service.ts";
import type { ChecklistCanvasItem } from "../../shared/model.ts";
import { anchorLabel, answersOf, findingSeverities, isCommentable, type Review, type ReviewAnswer, type ReviewFinding } from "../../shared/review.ts";
import { ReviewProblems } from "../review/snapshot.ts";
import { checklistItems, checklistOwners, checklistProgress, type ChecklistItem } from "../../shared/checklist.ts";
import { carriedOverDone, describeTicks, itemNamed, type UserTick } from "./checklist.ts";
import { MIRADOR_VERSION } from "../../shared/version.ts";
import type { AppDocuments } from "../apps/documents.ts";
import { registerAppTools } from "../apps/tools.ts";

const PROGRESS_HEARTBEAT_MS = 15_000;

const anchorSchema = (what: string) =>
  z.string().min(3).describe(`${what} Written "path:line" or "path:start-end": the path relative to the repository root, lines of the reviewed (new) version.`);

const flowStepSchema = z.object({
  title: z.string().min(1).describe("A few words, e.g. \"Controller accepts the request\"."),
  at: anchorSchema("Where this step happens; a range for a whole method. May be unchanged code the flow passes through."),
  say: z.string().min(1).describe("Markdown: what happens here and why it matters, in a few sentences."),
});

const tourStepSchema = flowStepSchema.extend({
  at: z
    .string()
    .min(3)
    .describe('Where this step happens; a range for a whole method. Written "path:line" or "path:start-end": the path relative to folder, lines of the file as it is now.'),
});

const tourSchema = z.object({
  title: z.string().min(1).describe('What the tour is about, e.g. "How a message reaches the agent".'),
  folder: z.string().min(1).describe("Absolute path of the folder the steps' paths are relative to, usually your working directory."),
  since: z
    .string()
    .optional()
    .describe(
      "To walk the user through what you changed: the git ref the changes count from, e.g. HEAD for uncommitted work, or the commit the task started from. Changed lines are marked in the steps and the diff gets a tab. Leave it out to show the code as it is.",
    ),
  summary: z.string().min(1).describe("Markdown for the user: what the code does, or what you changed, and how it flows, in plain words, so they understand it fast."),
  flow: z.array(tourStepSchema).min(1).describe("The tour, in the order the code runs: the entry point first, then each place control or data goes."),
});

const findingSchema = z.object({
  severity: z.enum(findingSeverities).describe("blocker: must change before merging; issue: should change; question: needs the author's answer; nit: optional polish."),
  checked: z.enum(["confirmed", "plausible"]).describe("confirmed: you verified it (ran, traced or tested it); plausible: suspected, not verified."),
  at: anchorSchema("The line(s) the comment is about. GitHub accepts comments only on changed lines and the 3 lines around them."),
  title: z.string().min(1).describe("A few words for the list of findings."),
  body: z
    .string()
    .min(1)
    .describe("Markdown: the comment as it would be posted on the pull request, addressed to the author. Write \"finding 2\", never a bare # and number."),
  evidence: z.string().optional().describe("Markdown: how you checked it, for the user only; not posted."),
});

const reviewSchema = z.object({
  title: z.string().min(1).describe("What is reviewed, e.g. \"PR 1234: retry stack creation\" (never a bare # and number: GitHub links those to issues)."),
  repository: z.string().min(1).describe("Absolute path of the git checkout (e.g. a worktree) where the reviewed code is checked out."),
  base: z.string().min(1).describe("Git ref the change goes into, e.g. origin/master. The review covers base...head, like a pull request."),
  head: z.string().optional().describe("Git ref of the reviewed code; the checkout's HEAD by default. Only committed code is reviewed."),
  pullRequest: z.string().optional().describe("The pull request's URL, when reviewing one. The user can then post the findings they keep to it as a pending review."),
  verdict: z.string().min(1).describe("One sentence: approve, approve with nits, or request changes, and the main reason."),
  summary: z
    .string()
    .min(1)
    .describe("Markdown for the user (not the author): what the change does and how its code flows, in plain words, so they understand it fast."),
  flow: z
    .array(flowStepSchema)
    .describe("A guided tour of the change's code flow, in the order the code runs: the entry point first, then each place control or data goes."),
  findings: z.array(findingSchema),
  answers: z
    .array(
      z.object({
        conversation: z
          .string()
          .min(1)
          .describe("The conversation this answers: the URL of any of its comments (…/pull/123#discussion_r456, as gh shows them), or its thread id (PRRT_…)."),
        body: z.string().min(1).describe("Markdown: the reply as it would be posted in the conversation. Write \"finding 2\", never a bare # and number."),
        resolve: z
          .boolean()
          .optional()
          .describe("Suggest resolving the conversation with this answer, e.g. when the author fixed what it was about. The user decides; resolving shows on GitHub at once."),
      }),
    )
    .optional()
    .describe(
      "When reviewing a pull request again: your answers to conversations (review threads) already on it, such as the author's replies to earlier comments. They are shown with the conversation as GitHub has it; the user keeps, edits or drops each, and posts the kept ones as replies on their pending review.",
    ),
});

const reviewEditSchema = z.object({
  review: z.string().optional().describe("The review to change, by the id the review tool reported; the conversation's newest review by default."),
  verdict: z.string().min(1).optional().describe("A new verdict."),
  summary: z.string().min(1).optional().describe("A new summary."),
  flow: z.array(flowStepSchema).optional().describe("The whole tour again, in order, when any step of it changes: it replaces the tour."),
  findings: z
    .array(findingSchema.partial().extend({ id: z.string().min(1).describe('The finding to change, e.g. "finding-2".') }))
    .optional()
    .describe(
      "Changes to findings: only the fields you pass change, and the user's keep or drop stays. The body the user asked you about is the one they see now, their own rewording included; a body you pass replaces it.",
    ),
  addFindings: z.array(findingSchema).optional().describe("New findings, added after the others."),
  removeFindings: z.array(z.string().min(1)).optional().describe('Findings to take out, by id, e.g. ["finding-3"].'),
  answers: z
    .array(
      z.object({
        id: z.string().min(1).describe('The answer to change, e.g. "answer-1".'),
        body: z.string().min(1).optional().describe("Markdown: the reply as it would be posted in the conversation."),
        resolve: z.boolean().optional().describe("Whether you suggest resolving the conversation with this answer."),
      }),
    )
    .optional()
    .describe("Changes to answers to conversations, by id. To answer a conversation the review does not answer yet, publish the review again."),
});

type Curated = ReviewFinding | ReviewAnswer;

const findingName = ({ id }: Curated) => id.replace("-", " ");

/** A review published again for the same change took over the user's choices; what the agent should know of them. */
function describeCarriedChoices(curated: Curated[]) {
  const named = (matching: (each: Curated) => boolean) => curated.filter(matching).map(findingName).join(", ");
  const choices = [
    ["Dropped by the user", named((each) => each.decision === "drop")],
    ["Already on the pull request as posted, so change those there", named((each) => !!each.postedAs)],
    ["Reworded by the user, wording kept since you left these as before", named((each) => !each.postedAs && each.agentBody !== undefined)],
  ].filter(([, ids]) => ids);
  if (choices.length === 0) return "";
  return ` The user's choices on the earlier review of this change carry over to the matching findings and answers. ${choices.map(([choice, ids]) => `${choice}: ${ids}.`).join(" ")}`;
}

const notOnTheDiff = (review: Review, findings: ReviewFinding[]) =>
  findings.filter((finding) => !isCommentable(review.files.find((file) => file.path === finding.at.path), finding.at)).map(findingName);

const cannotBePosted = (names: string[]) => ` These are not on lines of the pull request's diff, so they cannot be posted as line comments: ${names.join(", ")}.`;

/** The ids update_review takes, with enough of each for the agent to tell them apart. */
function describeIds(review: Review) {
  const ids = [
    ...review.findings.map((finding) => `${finding.id} "${finding.title}" at ${anchorLabel(finding.at)}`),
    ...answersOf(review).map((answer) => `${answer.id} to the conversation on ${answer.path}${answer.line === null ? "" : `:${answer.line}`}`),
  ];
  return ids.length === 0 ? "" : ` To change parts of it later, call update_review with these ids: ${ids.join("; ")}.`;
}

function describeReview(itemId: string, review: Review) {
  const answers = answersOf(review);
  const answerCount = answers.length > 0 ? `, ${answers.length} answers to conversations` : "";
  const counts = `${review.files.length} changed files, ${review.flow.length} flow steps${answerCount} and ${review.findings.length} findings`;
  const outsideDiff = notOnTheDiff(review, review.findings);
  const posting = !review.pullRequest
    ? ""
    : outsideDiff.length === 0
      ? " Every finding is on a line the pull request's diff accepts comments on."
      : cannotBePosted(outsideDiff);
  return `Shown to the user as review ${itemId}: ${counts}.${posting}${describeCarriedChoices([...review.findings, ...answers])}${describeIds(review)}`;
}

function describeEdit(itemId: string, review: Review, changed: string[], removed: string[]) {
  const done = [changed.length > 0 && `updated ${changed.join(", ")}`, removed.length > 0 && `took out ${removed.join(", ")}`].filter(Boolean).join(" and ");
  const outsideDiff = review.pullRequest ? notOnTheDiff(review, review.findings.filter(({ id }) => changed.includes(id))) : [];
  const posting = outsideDiff.length > 0 ? cannotBePosted(outsideDiff) : "";
  return `In review ${itemId}, ${done} in place; the user sees the change where they are in the review.${posting}`;
}

const checklistItemShape = {
  id: z.string().min(1).describe('A short id you name the item by in update_checklist, e.g. "tests".'),
  text: z.string().min(1).describe("The step, in a few words."),
  detail: z.string().optional().describe("Markdown shown under the text: what the step involves, or what came of it."),
  owner: z.enum(checklistOwners).optional().describe("Who is expected to do it: agent (the default), user, or both. Anyone may tick it."),
  done: z.boolean().optional().describe("Whether it is done; not done by default."),
};

const checklistSchema = z.object({
  title: z.string().min(1).describe('What the work is, e.g. "Release 0.4.2".'),
  sections: z
    .array(
      z.object({
        title: z.string().optional().describe("A heading for the section; leave it out for a list of one section."),
        items: z.array(z.object(checklistItemShape)).min(1),
      }),
    )
    .min(1)
    .describe("The steps, in the order they are done, in one or more sections. Ids are unique across the checklist."),
});

const checklistEditSchema = z.object({
  items: z
    .array(z.object(checklistItemShape).partial().extend({ id: z.string().min(1).describe("The item to change.") }))
    .optional()
    .describe("Items to tick, untick, reword or hand over: only the fields you pass change."),
  addItems: z
    .array(
      z.object({
        ...checklistItemShape,
        after: z.string().optional().describe("The item to add it after."),
        section: z.string().optional().describe("Without after: the section to add it at the end of, by title; a title no section has adds a new section at the end."),
      }),
    )
    .optional()
    .describe("New items; without after or section, at the end of the last section."),
  removeItems: z.array(z.string().min(1)).optional().describe("Items to take out, by id."),
});

const doneCount = (items: { done: boolean }[]) => {
  const { done, total } = checklistProgress(items);
  return `${done} of ${total} done`;
};

const heardTicks = (ticks: UserTick[], when: string) => (ticks.length === 0 ? "" : ` ${when}, the user ${describeTicks(ticks)}.`);

function describeChecklist(item: ChecklistCanvasItem, carried: ChecklistItem[], replaced: { title: string; ticks: UserTick[] } | undefined) {
  const items = checklistItems(item.checklist);
  const carriedNote = carried.length > 0 ? ` Done as on the checklist it replaces: ${carried.map(itemNamed).join(", ")}.` : "";
  const replacedNote = replaced ? heardTicks(replaced.ticks, `On the checklist it replaces ("${replaced.title}")`) : "";
  return `Shown to the user in the canvas's Checklist tab: ${items.length} items, ${doneCount(items)}.${carriedNote}${replacedNote} Tick items with update_checklist as you finish them, naming them by id: ${items.map(({ id }) => id).join(", ")}.`;
}

function describeChecklistEdit(item: ChecklistCanvasItem, { changed, added, removed, ticks }: { changed: string[]; added: string[]; removed: string[]; ticks: UserTick[] }) {
  const quoted = (ids: string[]) => ids.map((id) => `"${id}"`).join(", ");
  const done = [changed.length > 0 && `updated ${quoted(changed)}`, added.length > 0 && `added ${quoted(added)}`, removed.length > 0 && `took out ${quoted(removed)}`]
    .filter(Boolean)
    .join(", ");
  return `On the checklist, ${done}; ${doneCount(checklistItems(item.checklist))}.${heardTicks(ticks, "Since you last heard")}`;
}

const optionSchema = z.object({
  label: z.string().min(1).describe("Short name of the option; returned verbatim when chosen."),
  description: z.string().optional().describe("One or two sentences on the trade-off."),
  html: z.string().optional().describe("Optional HTML preview of this option (mockup, diagram, code sample)."),
});

const askQuestionShape = {
  html: z.string().optional().describe("Optional HTML shown above the options: the explanation or mockup the question is about. Put it here rather than in a show call just before."),
  allowOther: z.boolean().optional().describe("Let the user type an answer that is not one of the options."),
  optionWidth: z.number().int().positive().optional().describe("Optional least width of each answer box in CSS pixels, for options whose descriptions need more room. Boxes still sit side by side while they fit and never get wider than the canvas. Without it they are at least 200px, or as wide as the widest preview."),
};

function describeRender(itemId: string, render: RenderOutcome) {
  if (render === "no-viewer") {
    return `Saved to the canvas as item ${itemId}. Nobody is viewing this conversation right now, so rendering was not verified; if the page reports errors when the user opens it, you will hear of them with their next message.`;
  }
  if (render.errors.length === 0) return `Shown to the user as canvas item ${itemId}; it rendered without script errors.`;
  return `Shown to the user as canvas item ${itemId}, but the page reported errors:\n${render.errors.map((error) => `- ${error}`).join("\n")}`;
}

/**
 * With tool search on, Claude Code hides MCP tools until the agent searches for them, and an agent
 * that doesn't know the canvas exists rarely does. This marks the canvas tools as always loaded.
 */
const loadedUpFront = { "anthropic/alwaysLoad": true };

const toolError = (text: string) => ({ isError: true, content: [{ type: "text" as const, text }] });

/** opencode 2 names the session that calls a tool, its subagents' included. */
const OPENCODE_SESSION_META = "ai.opencode/sessionID";

function buildCanvasServer(
  conversationId: string,
  canvas: CanvasService,
  conversations: ConversationService,
  assetsOrigin: string,
  apps: AppDocuments | null,
  canvasPlugins: CanvasPlugins | null,
) {
  const server = new McpServer(
    { name: CANVAS_SERVER_NAME, version: MIRADOR_VERSION },
    { instructions: canvasInstructions(assetsOrigin, canvasPlugins?.guidance ?? NO_CANVAS_PLUGINS) },
  );

  /**
   * The conversations on one opencode agent process each add their canvas server under the same name, and opencode keeps
   * only the last one added: every call reaches that conversation's address, whichever conversation made it.
   */
  const callingConversation = async ({ mcpReq }: ServerContext) => {
    const sessionId = mcpReq._meta?.[OPENCODE_SESSION_META];
    return (typeof sessionId === "string" && (await conversations.conversationOfSession(sessionId))) || conversationId;
  };

  server.registerTool(
    "show",
    {
      description:
        "Render an HTML page in the user's browser canvas (diagrams, mockups, comparisons, charts, 3D). Prefer this over ASCII art or long text explanations. The page runs sandboxed without network access; three.js, D3 and Mermaid are available (see the server instructions).",
      inputSchema: z.object({
        title: z.string().min(1).describe("Short title shown above the page."),
        html: z.string().min(1).describe("A complete HTML document or an HTML fragment with inline CSS/JS."),
      }),
      _meta: loadedUpFront,
    },
    async ({ title, html }, ctx) => {
      const { item, render } = await canvas.show(await callingConversation(ctx), { title, html });
      return { content: [{ type: "text", text: describeRender(item.id, render) }] };
    },
  );

  server.registerTool(
    "ask",
    {
      description:
        "Ask the user to choose between options in their browser, optionally with an HTML preview per option and a shared HTML context page. Use this instead of asking multiple-choice questions in plain text. Depending on the user's setting, the choice is returned as this tool's result or arrives as the user's next message (the result tells you which). When you have two or more things to ask, pass questions instead of question and options, one entry per question with its own options: the user answers them page by page, and all their answers come back together. Never fold several questions into one question, and never offer options such as \"Accept all\" or \"Change some answers\" that stand for several answers: the user then has no way to say which.",
      inputSchema: z.object({
        ...askQuestionShape,
        question: z.string().min(1).optional().describe("The question, when you ask just one."),
        options: z.array(optionSchema).min(2).max(8).optional().describe("The choices to the question, when you ask just one."),
        questions: z
          .array(z.object({ ...askQuestionShape, question: z.string().min(1), options: z.array(optionSchema).min(2).max(8) }))
          .min(2)
          .max(10)
          .optional()
          .describe("Two or more questions in the order to ask them, each with its own options; give these instead of question and options whenever you have more than one thing to ask."),
      }),
      _meta: loadedUpFront,
    },
    async ({ questions, question, options, ...rest }, ctx) => {
      if (questions && (question || options)) return toolError("Give either question and options, or questions, not both.");
      if (!questions && (!question || !options)) return toolError("Give question and options, or questions.");
      if (questions && Object.values(rest).some((value) => value !== undefined))
        return toolError("With questions, give html, allowOther and optionWidth on each question, not next to questions.");
      const caller = await callingConversation(ctx);
      const item = canvas.openAsk(caller, questions ? { questions } : { question: question!, options: options!, ...rest });
      if (conversations.get(caller).askMode === "next-message") {
        return {
          content: [
            {
              type: "text",
              text: "The question is now showing in the user's browser. Their answer will arrive as their next message. End your turn now without assuming an answer.",
            },
          ],
        };
      }
      const progressToken = ctx.mcpReq._meta?.progressToken;
      let beats = 0;
      const heartbeat =
        progressToken === undefined
          ? undefined
          : setInterval(() => {
              beats += 1;
              ctx.mcpReq
                .notify({
                  method: "notifications/progress",
                  params: { progressToken, progress: beats, message: "Waiting for the user's choice" },
                })
                .catch(() => {});
            }, PROGRESS_HEARTBEAT_MS);
      try {
        const answer = await canvas.waitForAnswer(item, ctx.mcpReq.signal);
        return { content: [{ type: "text", text: answerAsToolResult(answer) }] };
      } finally {
        clearInterval(heartbeat);
      }
    },
  );

  server.registerTool(
    "tour",
    {
      description:
        "Publish a guided tour of the code flow to the user's canvas: a summary, then steps in the order the code runs, each anchored to lines the page shows with the code around them (read from the files, so do not paste code). Use it to explain how code works, or with since to walk the user through what you changed: changed lines are marked and the diff gets a tab. The user can ask you about any lines. Anchors are checked; if any are wrong, nothing is shown and the result lists them all. To change a tour, publish it again.",
      inputSchema: tourSchema,
      _meta: loadedUpFront,
    },
    async (request, ctx) => {
      try {
        const { id, tour } = await canvas.tour(await callingConversation(ctx), request);
        const changes = tour.changes ? `, ${tour.files.length} files changed since ${tour.changes.since}` : "";
        return { content: [{ type: "text", text: `Shown to the user as tour ${id}: ${tour.flow.length} flow steps${changes}.` }] };
      } catch (error) {
        if (error instanceof ReviewProblems) return toolError(error.message);
        throw error;
      }
    },
  );

  server.registerTool(
    "review",
    {
      description:
        "Publish a code review to the user's canvas as an interactive review: a summary, a guided tour of the code flow, the diff (taken from git, so do not paste code), and your findings on the lines they are about. The user can ask you about any lines, keep or drop findings, and post the kept ones to the pull request. When reviewing a pull request again, also answer its existing conversations (answers). Publishing the same change again keeps the user's choices on findings with the same file and title or lines, and on answers to the same conversation. Anchors and conversations are checked; if any are wrong, nothing is shown and the result lists them all. To change parts of a review already shown, use update_review instead.",
      inputSchema: reviewSchema,
      _meta: loadedUpFront,
    },
    async (request, ctx) => {
      try {
        const item = await canvas.review(await callingConversation(ctx), request);
        return { content: [{ type: "text", text: describeReview(item.id, item.review) }] };
      } catch (error) {
        if (error instanceof ReviewProblems) return { isError: true, content: [{ type: "text", text: error.message }] };
        throw error;
      }
    },
  );

  server.registerTool(
    "update_review",
    {
      description:
        "Change parts of a review already on the canvas, in place: reword, move, add or take out findings, change answers, the tour, the summary or the verdict. Only what you pass changes; the user keeps their place in the review and their choices on everything else. Name findings and answers by the ids the review tool reported (finding-2, answer-1). Publish the whole review again with review only when the code under review changed.",
      inputSchema: reviewEditSchema,
      _meta: loadedUpFront,
    },
    async (request, ctx) => {
      try {
        const { item, changed, removed } = await canvas.editReview(await callingConversation(ctx), request);
        return { content: [{ type: "text", text: describeEdit(item.id, item.review, changed, removed) }] };
      } catch (error) {
        if (error instanceof ReviewProblems) return toolError(error.message);
        throw error;
      }
    },
  );

  server.registerTool(
    "checklist",
    {
      description:
        "Publish a checklist of the steps of your work in a tab beside the user's canvas, and tick its items with update_checklist as you finish them. The user sees how far along you are, and can tick items too: you hear of their ticks with their next message or in update_checklist's result. Each item is yours, the user's or both of yours to do. A conversation has one checklist: publishing again replaces it, and items with the same ids keep their ticks unless you pass done. If the user dismisses the checklist, don't publish it again unless they ask for one.",
      inputSchema: checklistSchema,
      _meta: loadedUpFront,
    },
    async (request, ctx) => {
      try {
        const { item, replaced } = canvas.publishChecklist(await callingConversation(ctx), request);
        return { content: [{ type: "text", text: describeChecklist(item, carriedOverDone(request, item.checklist), replaced) }] };
      } catch (error) {
        if (error instanceof ReviewProblems) return toolError(error.message);
        throw error;
      }
    },
  );

  server.registerTool(
    "update_checklist",
    {
      description:
        "Change the checklist already beside the canvas, in place: tick or untick items, reword them, hand them over, add or take them out, by the ids you gave them. The items you change flash once for the user. The result tells you what the user ticked or unticked since you last heard. Unknown ids change nothing; the result lists them.",
      inputSchema: checklistEditSchema,
      _meta: loadedUpFront,
    },
    async (edit, ctx) => {
      try {
        const { item, ...outcome } = canvas.editChecklist(await callingConversation(ctx), edit);
        return { content: [{ type: "text", text: describeChecklistEdit(item, outcome) }] };
      } catch (error) {
        if (error instanceof ReviewProblems) return toolError(error.message);
        throw error;
      }
    },
  );

  server.registerTool(
    "when_done",
    {
      description: jobWaitToolDescription(),
      inputSchema: z.object({
        pid: z.number().optional().describe("The process to wait for, by its pid."),
        container: z.string().optional().describe("Or the Docker or Podman container to wait for, by its name or id."),
        host: z.string().optional().describe("For a job on another machine: user@host, or a name from your ssh config. Mirador checks on it over ssh."),
        message: z.string().optional().describe("Your instruction for picking up the work once the job ends. Without one, the message says the job ended."),
        resume: z
          .boolean()
          .optional()
          .describe("false when the user should decide what happens next: Mirador then only tells them, and you get nothing. True by default."),
      }),
      _meta: loadedUpFront,
    },
    async ({ pid, container, host, message, resume }, ctx) => {
      if ((pid === undefined) === (container === undefined)) return toolError("Name the job: either its pid or its container.");
      const job = pid === undefined ? { kind: "container", name: container } : { kind: "process", pid };
      const request = readJobWaitRequest({ job, sshHost: host ?? null, message: message ?? null, resume: resume ?? true });
      if (typeof request === "string") return toolError(request);
      try {
        return { content: [{ type: "text", text: waitSetUpReply(await conversations.waitForJob(await callingConversation(ctx), request)) }] };
      } catch (error) {
        if (error instanceof JobWaitRefused) return toolError(error.message);
        throw error;
      }
    },
  );

  if (apps && apps.installed().length > 0) registerAppTools(server, apps, conversations, callingConversation);
  canvasPlugins?.registerTools(server, callingConversation);

  return server;
}

export class CanvasMcpEndpoints {
  private readonly handlers = new Map<string, McpHttpHandler>();

  constructor(
    private readonly canvas: CanvasService,
    private readonly conversations: ConversationService,
    private readonly assetsOrigin: string,
    private readonly apps: AppDocuments | null = null,
    private readonly canvasPlugins: CanvasPlugins | null = null,
  ) {}

  handle(conversationId: string, request: Request) {
    return this.handlerFor(conversationId).fetch(request);
  }

  forget(conversationId: string) {
    this.handlers.delete(conversationId);
  }

  private handlerFor(conversationId: string) {
    let handler = this.handlers.get(conversationId);
    if (!handler) {
      handler = createMcpHandler(() =>
        buildCanvasServer(conversationId, this.canvas, this.conversations, this.assetsOrigin, this.apps, this.canvasPlugins),
      );
      this.handlers.set(conversationId, handler);
    }
    return handler;
  }
}
