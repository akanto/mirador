import type * as acp from "@agentclientprotocol/sdk";
import { questionsOf } from "../shared/ask.ts";
import type { CanvasItem, PendingAsk, PendingPermissionRequest } from "../shared/model.ts";
import { cutWithEllipsis } from "../shared/text-cut.ts";

/** As much of a command as a list of waiting conversations shows; the conversation has all of it. */
const COMMAND_SHOWN = 500;

function stringField(value: unknown, key: string) {
  const field = (value as Record<string, unknown> | null | undefined)?.[key];
  return typeof field === "string" ? field : null;
}

const shortened = (text: string) => cutWithEllipsis(text, COMMAND_SHOWN);

/** `kindSeenBefore`: the kind of the tool call the request is about, from the agent's updates, for an agent that leaves it off the request. */
export function pendingPermission(
  permissionId: string,
  { toolCall, options }: Pick<acp.RequestPermissionRequest, "toolCall" | "options">,
  kindSeenBefore: acp.ToolKind | null = null,
): PendingPermissionRequest {
  const title = toolCall.title ?? "a tool";
  const toolKind = toolCall.kind ?? kindSeenBefore;
  const runsCommand = toolKind === "execute";
  return {
    kind: "permission",
    permissionId,
    title,
    toolKind,
    command: runsCommand ? shortened(stringField(toolCall.rawInput, "command") ?? title) : null,
    description: runsCommand ? stringField(toolCall.rawInput, "description") : null,
    options,
  };
}

export function pendingAsk(item: CanvasItem): PendingAsk {
  const questions = questionsOf(item);
  const first = questions[0];
  return {
    kind: "ask",
    itemId: item.id,
    question: first?.question ?? item.title,
    choices: (first?.options ?? []).map(({ label, description }) => ({ label, ...(description && { description }) })),
    allowOther: first?.allowOther ?? false,
    questions: questions.length,
    previews: questions.some(({ html, options }) => Boolean(html) || options.some((option) => Boolean(option.html))),
  };
}
