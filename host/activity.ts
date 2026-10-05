import type * as acp from "@agentclientprotocol/sdk";
import type { Activity } from "../shared/model.ts";

const hasFinished = (status: acp.ToolCallStatus | null | undefined) => status === "completed" || status === "failed";

/** The running turn's tool calls that have not finished yet, by id, with the title each was last given. */
export class OpenToolCalls {
  private readonly titles = new Map<string, string>();

  get size() {
    return this.titles.size;
  }

  clear() {
    this.titles.clear();
  }

  /** Whether the update finished a tool call. */
  follow(update: acp.SessionUpdate) {
    if (update.sessionUpdate === "tool_call" && !hasFinished(update.status)) {
      this.titles.set(update.toolCallId, update.title);
      return false;
    }
    if (update.sessionUpdate !== "tool_call_update") return false;
    if (hasFinished(update.status)) {
      this.titles.delete(update.toolCallId);
      return true;
    }
    if (update.title && this.titles.has(update.toolCallId)) this.titles.set(update.toolCallId, update.title);
    return false;
  }

  /** The one started last. */
  latest() {
    return [...this.titles.values()].at(-1) ?? null;
  }
}

/** What a working agent does now: the tool it waits for permission to run, else the tool call it started last that has not finished. */
export function currentActivity(openToolCalls: OpenToolCalls, toolsAwaitingPermission: string[]): Activity | null {
  const awaitingPermission = toolsAwaitingPermission.at(-1);
  if (awaitingPermission !== undefined) return { kind: "permission", title: awaitingPermission };
  const tool = openToolCalls.latest();
  return tool === null ? null : { kind: "tool", title: tool };
}
