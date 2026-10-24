import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { ConversationService } from "../conversations.ts";
import { type AppDocuments } from "./documents.ts";
import { AppProblem } from "./plugins.ts";

const toolError = (text: string) => ({ isError: true, content: [{ type: "text" as const, text }] });
const toolText = (text: string) => ({ content: [{ type: "text" as const, text }] });

/** With tool search on, Claude Code hides MCP tools until the agent searches for them; an agent asked to change an app's document should find these at once. */
const loadedUpFront = { "anthropic/alwaysLoad": true };

const appNameSchema = z.string().optional().describe("The app, when more than one is open in the workspace.");

/**
 * The same four tools in every workspace, whichever apps are open there: the tool list never changes, so agents
 * that cache it stay right. Registered only when the owner installed an app plugin.
 */
export function registerAppTools(
  server: McpServer,
  apps: AppDocuments,
  conversations: ConversationService,
  callingConversation: (ctx: ServerContext) => Promise<string>,
) {
  const names = apps.installed().map(({ name, title }) => `${name} (${title})`).join(", ");
  const answered = async (ctx: ServerContext, answer: (workspaceId: string, conversationId: string) => Promise<string> | string) => {
    try {
      const conversationId = await callingConversation(ctx);
      return toolText(await answer(conversations.get(conversationId).workspaceId, conversationId));
    } catch (error) {
      if (error instanceof AppProblem) return toolError(error.message);
      throw error;
    }
  };

  server.registerTool(
    "app_open",
    {
      description: `Open an app the user installed in Mirador on a file of this workspace; the user sees it live in a tab of the canvas, and every conversation in the workspace works on the same document. A file that doesn't exist yet is started. Installed apps: ${names}. Then read the document with app_state and change it with apply.`,
      inputSchema: z.object({
        app: z.string().describe("The app's name, e.g. one of those installed."),
        file: z.string().min(1).describe("The document's path, relative to the workspace."),
      }),
      _meta: loadedUpFront,
    },
    ({ app, file }, ctx) =>
      answered(ctx, async (workspaceId) => {
        const opened = await apps.open(workspaceId, app, file);
        return `${opened.title} is open on ${opened.file}; the user sees it in the canvas.\n\n${apps.describe(workspaceId, opened.app)}`;
      }),
  );

  server.registerTool(
    "apply",
    {
      description:
        "Change the document of the app open in this workspace with one operation. The app checks it and applies it in turn with the user's own changes, and the result says what changed or what was wrong. Never edit the app's file to change it: an operation is recorded as yours and can be undone. app_state says which operations the app takes.",
      inputSchema: z.object({
        op: z.record(z.string(), z.unknown()).describe('The operation, as the app defines it, e.g. { "op": "add", "by": 2 }.'),
        app: appNameSchema,
      }),
      _meta: loadedUpFront,
    },
    ({ op, app }, ctx) =>
      answered(ctx, async (workspaceId, conversationId) => {
        const change = await apps.apply(workspaceId, app, op, { kind: "agent", conversationId, turnSeq: conversations.latestTurnSeq(conversationId) });
        return change.summary;
      }),
  );

  server.registerTool(
    "app_run",
    {
      description:
        "Run one of the tasks of the app open in this workspace, such as a render, and wait until it ends; the user sees its progress in the app and can stop it. app_state lists the app's tasks. Run one when your operations are done and the user should see their result.",
      inputSchema: z.object({
        task: z.string().describe("The task's name, as app_state lists it."),
        app: appNameSchema,
      }),
      _meta: loadedUpFront,
    },
    ({ task, app }, ctx) =>
      answered(ctx, (workspaceId, conversationId) => apps.startTask(workspaceId, app, task, { kind: "agent", conversationId, turnSeq: conversations.latestTurnSeq(conversationId) }).ended),
  );

  server.registerTool(
    "app_state",
    {
      description: "The document of the app open in this workspace, in words, with its latest changes, the user's included. Read it before changing the document, and again when an operation names something that isn't there.",
      inputSchema: z.object({ app: appNameSchema }),
      _meta: loadedUpFront,
    },
    ({ app }, ctx) => answered(ctx, (workspaceId) => apps.describe(workspaceId, app)),
  );
}
