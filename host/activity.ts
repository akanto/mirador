import type * as acp from "@agentclientprotocol/sdk";
import type { Activity } from "../shared/model.ts";

const hasFinished = (status: acp.ToolCallStatus | null | undefined) => status === "completed" || status === "failed";

/** The running turn's tool calls that have not finished yet, by id, with the title each was last given and the kind of tool the agent said it is. */
export class OpenToolCalls {
  private readonly titles = new Map<string, string>();
  private readonly kinds = new Map<string, acp.ToolKind>();

  get size() {
    return this.titles.size;
  }

  clear() {
    this.titles.clear();
    this.kinds.clear();
  }

  /** Whether the update finished a tool call. */
  follow(update: acp.SessionUpdate) {
    if (update.sessionUpdate === "tool_call" && !hasFinished(update.status)) {
      this.titles.set(update.toolCallId, update.title);
      if (update.kind) this.kinds.set(update.toolCallId, update.kind);
      return false;
    }
    if (update.sessionUpdate !== "tool_call_update") return false;
    if (hasFinished(update.status)) {
      this.titles.delete(update.toolCallId);
      this.kinds.delete(update.toolCallId);
      return true;
    }
    if (!this.titles.has(update.toolCallId)) return false;
    if (update.title) this.titles.set(update.toolCallId, update.title);
    if (update.kind) this.kinds.set(update.toolCallId, update.kind);
    return false;
  }

  /** The kind of tool an open tool call is, when the agent said. */
  kindOf(toolCallId: string) {
    return this.kinds.get(toolCallId) ?? null;
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
