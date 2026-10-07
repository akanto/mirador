import { createMcpHandler, McpServer, type McpHttpHandler } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { ConversationService } from "../conversations.ts";
import { CANVAS_SERVER_NAME } from "../acp/harnesses.ts";
import { JobWaitRefused, jobWaitToolDescription } from "../job-waits.ts";
import { readJobWaitRequest, waitSetUpReply } from "../../shared/job-waits.ts";
import { answerAsToolResult, type CanvasService, type RenderOutcome } from "./service.ts";
import { answersOf, findingSeverities, isCommentable, type Review, type ReviewAnswer, type ReviewFinding } from "../../shared/review.ts";
import { ReviewProblems } from "../review/snapshot.ts";
import { MIRADOR_VERSION } from "../../shared/version.ts";

const PROGRESS_HEARTBEAT_MS = 15_000;

export function canvasInstructions(assetsOrigin: string) {
  return `The canvas is a browser panel next to this conversation. The user finds long terminal text and ASCII diagrams hard to read, so prefer the canvas for anything visual.

- show: render an HTML page: architecture or flow diagrams, UI mockups, side-by-side comparisons, charts, 3D scenes, visual explanations, code-review walkthroughs.
- ask: whenever you need the user to decide between options (design choices, approaches, trade-offs), ask here instead of in plain text. Give each option a short label and, when it helps, an HTML preview. A question takes the canvas's place of what you showed before, so to ask about a page, pass it as the question's html rather than calling show first.
- review: when you review code changes (a pull request or a branch), publish the review with this tool rather than show. The user reads it as a guided tour of the code flow, the diff with your findings on it, and posts the findings they keep to the pull request.

Rendering environment: every page renders in a sandboxed iframe with NO network access (no fetch, no external CDNs, fonts or images), shown light or dark as the panel's theme is. Write self-contained HTML with inline CSS and JS, and pick every colour (background, text, cards, borders, lines) with light-dark() so the page follows that theme, e.g. <style>html { background: light-dark(#ffffff, #111214); color: light-dark(#1c1c1e, #ececee); }</style>. Don't use @media (prefers-color-scheme): it follows the system, not the panel. A script that draws in colour reads the theme as getComputedStyle(document.documentElement).colorScheme, "light" or "dark". Available libraries:
- three.js (ES modules): <script type="module">import * as THREE from "three"; import { OrbitControls } from "three/addons/controls/OrbitControls.js";</script>
- D3 v7: <script src="${assetsOrigin}/d3.min.js"></script> (global d3)
- Mermaid: <script src="${assetsOrigin}/mermaid.min.js"></script><script>mermaid.initialize({ startOnLoad: true, theme: getComputedStyle(document.documentElement).colorScheme === "dark" ? "dark" : "default" })</script> with <pre class="mermaid">...</pre>
When someone is viewing the conversation, show reports back script errors from the page so you can fix them.`;
}

const anchorSchema = (what: string) =>
  z.string().min(3).describe(`${what} Written "path:line" or "path:start-end": the path relative to the repository root, lines of the reviewed (new) version.`);

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
    .array(
      z.object({
        title: z.string().min(1).describe("A few words, e.g. \"Controller accepts the request\"."),
        at: anchorSchema("Where this step happens; a range for a whole method. May be unchanged code the flow passes through."),
        say: z.string().min(1).describe("Markdown: what happens here and why it matters, in a few sentences."),
      }),
    )
    .describe("A guided tour of the change's code flow, in the order the code runs: the entry point first, then each place control or data goes."),
  findings: z.array(
    z.object({
      severity: z.enum(findingSeverities).describe("blocker: must change before merging; issue: should change; question: needs the author's answer; nit: optional polish."),
      checked: z.enum(["confirmed", "plausible"]).describe("confirmed: you verified it (ran, traced or tested it); plausible: suspected, not verified."),
      at: anchorSchema("The line(s) the comment is about. GitHub accepts comments only on changed lines and the 3 lines around them."),
      title: z.string().min(1).describe("A few words for the list of findings."),
      body: z
        .string()
        .min(1)
        .describe("Markdown: the comment as it would be posted on the pull request, addressed to the author. Write \"finding 2\", never a bare # and number."),
      evidence: z.string().optional().describe("Markdown: how you checked it, for the user only; not posted."),
    }),
  ),
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

function describeReview(itemId: string, review: Review) {
  const answers = answersOf(review);
  const answerCount = answers.length > 0 ? `, ${answers.length} answers to conversations` : "";
  const counts = `${review.files.length} changed files, ${review.flow.length} flow steps${answerCount} and ${review.findings.length} findings`;
  const fileOf = (path: string) => review.files.find((file) => file.path === path);
  const outsideDiff = review.findings.filter((finding) => !isCommentable(fileOf(finding.at.path), finding.at)).map(findingName);
  const posting = !review.pullRequest
    ? ""
    : outsideDiff.length === 0
      ? " Every finding is on a line the pull request's diff accepts comments on."
      : ` These are not on lines of the pull request's diff, so they cannot be posted as line comments: ${outsideDiff.join(", ")}.`;
  return `Shown to the user as review ${itemId}: ${counts}.${posting}${describeCarriedChoices([...review.findings, ...answers])}`;
}

const optionSchema = z.object({
  label: z.string().min(1).describe("Short name of the option; returned verbatim when chosen."),
  description: z.string().optional().describe("One or two sentences on the trade-off."),
  html: z.string().optional().describe("Optional HTML preview of this option (mockup, diagram, code sample)."),
});

function describeRender(itemId: string, render: RenderOutcome) {
  if (render === "no-viewer") {
    return `Saved to the canvas as item ${itemId}. Nobody is viewing this conversation right now, so rendering was not verified.`;
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

function buildCanvasServer(conversationId: string, canvas: CanvasService, conversations: ConversationService, assetsOrigin: string) {
  const server = new McpServer(
    { name: CANVAS_SERVER_NAME, version: MIRADOR_VERSION },
    { instructions: canvasInstructions(assetsOrigin) },
  );

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
    async ({ title, html }) => {
      const { item, render } = await canvas.show(conversationId, { title, html });
      return { content: [{ type: "text", text: describeRender(item.id, render) }] };
    },
  );

  server.registerTool(
    "ask",
    {
      description:
        "Ask the user to choose between options in their browser, optionally with an HTML preview per option and a shared HTML context page. Use this instead of asking multiple-choice questions in plain text. Depending on the user's setting, the choice is returned as this tool's result or arrives as the user's next message (the result tells you which).",
      inputSchema: z.object({
        question: z.string().min(1),
        html: z.string().optional().describe("Optional HTML shown above the options: the explanation or mockup the question is about. Put it here rather than in a show call just before."),
        options: z.array(optionSchema).min(2).max(8),
        allowOther: z.boolean().optional().describe("Let the user type an answer that is not one of the options."),
      }),
      _meta: loadedUpFront,
    },
    async (request, ctx) => {
      const item = canvas.openAsk(conversationId, request);
      if (conversations.get(conversationId).askMode === "next-message") {
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
    "review",
    {
      description:
        "Publish a code review to the user's canvas as an interactive review: a summary, a guided tour of the code flow, the diff (taken from git, so do not paste code), and your findings on the lines they are about. The user can ask you about any lines, keep or drop findings, and post the kept ones to the pull request. When reviewing a pull request again, also answer its existing conversations (answers). Publishing the same change again keeps the user's choices on findings with the same file and title or lines, and on answers to the same conversation. Anchors and conversations are checked; if any are wrong, nothing is shown and the result lists them all.",
      inputSchema: reviewSchema,
      _meta: loadedUpFront,
    },
    async (request) => {
      try {
        const item = await canvas.review(conversationId, request);
        return { content: [{ type: "text", text: describeReview(item.id, item.review) }] };
      } catch (error) {
        if (error instanceof ReviewProblems) return { isError: true, content: [{ type: "text", text: error.message }] };
        throw error;
      }
    },
  );

  server.registerTool(
    "when_done",
    {
      description: jobWaitToolDescription,
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
    async ({ pid, container, host, message, resume }) => {
      if ((pid === undefined) === (container === undefined)) return toolError("Name the job: either its pid or its container.");
      const job = pid === undefined ? { kind: "container", name: container } : { kind: "process", pid };
      const request = readJobWaitRequest({ job, sshHost: host ?? null, message: message ?? null, resume: resume ?? true });
      if (typeof request === "string") return toolError(request);
      try {
        return { content: [{ type: "text", text: waitSetUpReply(await conversations.waitForJob(conversationId, request)) }] };
      } catch (error) {
        if (error instanceof JobWaitRefused) return toolError(error.message);
        throw error;
      }
    },
  );

  return server;
}

export class CanvasMcpEndpoints {
  private readonly handlers = new Map<string, McpHttpHandler>();

  constructor(
    private readonly canvas: CanvasService,
    private readonly conversations: ConversationService,
    private readonly assetsOrigin: string,
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
        buildCanvasServer(conversationId, this.canvas, this.conversations, this.assetsOrigin),
      );
      this.handlers.set(conversationId, handler);
    }
    return handler;
  }
}
