import { createMcpHandler, McpServer, type McpHttpHandler } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { ConversationService } from "../conversations.ts";
import { CANVAS_SERVER_NAME } from "../acp/harnesses.ts";
import { answerAsToolResult, type CanvasService, type RenderOutcome } from "./service.ts";

const PROGRESS_HEARTBEAT_MS = 15_000;

export function canvasInstructions(assetsOrigin: string) {
  return `The canvas is a browser panel next to this conversation. The user finds long terminal text and ASCII diagrams hard to read, so prefer the canvas for anything visual.

- show: render an HTML page: architecture or flow diagrams, UI mockups, side-by-side comparisons, charts, 3D scenes, visual explanations, code-review walkthroughs.
- ask: whenever you need the user to decide between options (design choices, approaches, trade-offs), ask here instead of in plain text. Give each option a short label and, when it helps, an HTML preview.

Rendering environment: every page renders in a sandboxed iframe with NO network access (no fetch, no external CDNs, fonts or images). Write self-contained HTML with inline CSS and JS and set an explicit background colour. Available libraries:
- three.js (ES modules): <script type="module">import * as THREE from "three"; import { OrbitControls } from "three/addons/controls/OrbitControls.js";</script>
- D3 v7: <script src="${assetsOrigin}/d3.min.js"></script> (global d3)
- Mermaid: <script src="${assetsOrigin}/mermaid.min.js"></script><script>mermaid.initialize({ startOnLoad: true })</script> with <pre class="mermaid">...</pre>
When someone is viewing the conversation, show reports back script errors from the page so you can fix them.`;
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

function buildCanvasServer(conversationId: string, canvas: CanvasService, conversations: ConversationService, assetsOrigin: string) {
  const server = new McpServer(
    { name: CANVAS_SERVER_NAME, version: "0.1.0" },
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
        html: z.string().optional().describe("Optional HTML shown above the options, e.g. the mockup being discussed."),
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
