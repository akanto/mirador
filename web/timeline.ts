import type {
  ContentBlock,
  PermissionOption,
  PlanEntry,
  StopReason,
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolCallUpdate,
  ToolKind,
} from "@agentclientprotocol/sdk";
import type { StoredEvent } from "../shared/model.ts";
import { UserCommandLog, type UserCommand } from "../shared/user-commands.ts";

/** The stored event a block starts with: its sequence number keys the block, and its time is the block's time. */
export interface Origin {
  key: string;
  at: number;
}

export interface ToolBlock extends Origin {
  kind: "tool";
  toolCallId: string;
  title: string;
  toolKind?: ToolKind | null;
  status?: ToolCallStatus | null;
  content: ToolCallContent[];
  locations: ToolCallLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
  toolName?: string;
  endedAt?: number;
  /** Set on the Agent (or Task) tool call that started a subagent. */
  subagent?: Subagent;
}

/** What a subagent did, kept under the tool call that started it: claude-agent-acp marks its updates with that call's id. */
export interface Subagent {
  blocks: TimelineBlock[];
  lastActivityAt: number;
  /** How the turn that started it ended, once it has. */
  turnEnded: StopReason | null;
}

export type SubagentBlock = ToolBlock & { subagent: Subagent };

export type SubagentState = "running" | "done" | "failed" | "stopped";

const SUBAGENT_TOOLS = new Set(["Agent", "Task"]);

export const subagentInput = (block: ToolBlock) =>
  (block.rawInput ?? {}) as { description?: unknown; subagent_type?: unknown; model?: unknown; run_in_background?: unknown };

export const runsInBackground = (block: ToolBlock) => subagentInput(block).run_in_background === true;

/**
 * A subagent works until its tool call completes; one started in the background, whose call completes at once, works
 * until the turn that started it ends, since claude-agent-acp holds the turn open for it.
 */
export function subagentState(block: SubagentBlock, conversationBusy: boolean): SubagentState {
  if (block.status === "failed") return "failed";
  if (!runsInBackground(block) && block.status === "completed") return "done";
  const { turnEnded } = block.subagent;
  if (turnEnded) return turnEnded === "end_turn" ? "done" : "stopped";
  return conversationBusy ? "running" : "stopped";
}

/** When the subagent stopped working: its last activity when it ran in the background, else when its call completed. */
export const subagentEndedAt = (block: SubagentBlock) =>
  runsInBackground(block) ? block.subagent.lastActivityAt : (block.endedAt ?? block.subagent.lastActivityAt);

/** Every subagent in the timeline in the order they started, each followed by the ones it started. */
export function subagentsIn(blocks: TimelineBlock[]): SubagentBlock[] {
  return blocks.flatMap((block) => (block.kind === "tool" && block.subagent ? [block as SubagentBlock, ...subagentsIn(block.subagent.blocks)] : []));
}

export interface PermissionBlock extends Origin {
  kind: "permission";
  permissionId: string;
  toolCall: ToolCallUpdate;
  options: PermissionOption[];
  resolved: boolean;
  chosenOptionId: string | null;
}

type PlanBlock = Origin & { kind: "plan"; entries: PlanEntry[] };

export type TimelineBlock =
  | (Origin & { kind: "agent" | "thought" | "notice" | "info"; text: string })
  | (Origin & { kind: "user"; text: string; imageIds?: string[]; fromScript?: true })
  | ToolBlock
  | PlanBlock
  | PermissionBlock
  | (Origin & { kind: "command"; command: UserCommand })
  | (Origin & { kind: "error"; message: string; usageLimit?: true });

export type Author = "user" | "script" | "agent";

export function authorOf(block: TimelineBlock | undefined): Author | null {
  if (!block || block.kind === "notice") return null;
  if (block.kind === "user" && block.fromScript) return "script";
  return block.kind === "user" || block.kind === "command" ? "user" : "agent";
}

export function startsAuthorGroup(timeline: TimelineBlock[], index: number) {
  const author = authorOf(timeline[index]);
  return author !== null && author !== authorOf(timeline[index - 1]);
}

type TextBlockKind = "user" | "agent" | "thought";

export function contentText(content: ContentBlock): string {
  switch (content.type) {
    case "text":
      return content.text;
    case "resource_link":
      return `[${content.name}](${content.uri})`;
    case "resource":
      return "text" in content.resource ? content.resource.text : `(binary resource ${content.resource.uri})`;
    default:
      return `(${content.type} content)`;
  }
}

/** claude-agent-acp tags hook output and similar notices this way; they are not part of the reply. */
function isInformational(meta: { [key: string]: unknown } | null | undefined) {
  const claudeCode = meta?.claudeCode as { kind?: unknown } | undefined;
  return claudeCode?.kind === "informational";
}

function claudeCodeMeta(update: { _meta?: { [key: string]: unknown } | null }) {
  const claudeCode = (update._meta?.claudeCode ?? {}) as { toolName?: unknown; parentToolUseId?: unknown };
  return {
    toolName: typeof claudeCode.toolName === "string" ? claudeCode.toolName : undefined,
    parentToolUseId: typeof claudeCode.parentToolUseId === "string" ? claudeCode.parentToolUseId : undefined,
  };
}

class TimelineBuilder {
  readonly blocks: TimelineBlock[] = [];
  private readonly toolBlocks = new Map<string, ToolBlock>();
  private readonly permissionBlocks = new Map<string, PermissionBlock>();
  private currentPlan: PlanBlock | null = null;
  private readonly subagentsOfThisTurn: Subagent[] = [];
  private readonly commands = new UserCommandLog();

  add({ seq, at, event }: StoredEvent) {
    const origin = { key: String(seq), at };
    this.commands.apply(event);
    switch (event.type) {
      case "user-command":
        return this.push({ kind: "command", ...origin, command: this.commands.get(event.commandId)! });
      case "user-command-output":
      case "user-command-ended":
      case "user-command-dropped":
        return;
      case "user-message":
        this.currentPlan = null;
        return this.push({
          kind: "user",
          ...origin,
          text: event.text,
          ...(event.imageIds && { imageIds: event.imageIds }),
          ...(event.fromScript && { fromScript: event.fromScript }),
        });
      case "turn-end":
        this.currentPlan = null;
        this.subagentsOfThisTurn.splice(0).forEach((subagent) => (subagent.turnEnded = event.stopReason));
        if (event.stopReason === "end_turn") return;
        return this.push({ kind: "notice", ...origin, text: `Turn ended: ${event.stopReason.replaceAll("_", " ")}` });
      case "error":
        return this.push({ kind: "error", ...origin, message: event.message, ...(event.usageLimit && { usageLimit: true as const }) });
      case "usage-limit-wait-stopped":
        return this.push({ kind: "notice", ...origin, text: "Stopped waiting for the usage limit to reset" });
      case "profile-changed":
        return this.push({ kind: "notice", ...origin, text: event.profileName ? `Now using the profile “${event.profileName}”` : "Now using the agent's own setup, without a profile" });
      case "permission": {
        const block: PermissionBlock = {
          kind: "permission",
          ...origin,
          permissionId: event.permissionId,
          toolCall: event.toolCall,
          options: event.options,
          resolved: false,
          chosenOptionId: null,
        };
        this.permissionBlocks.set(event.permissionId, block);
        return this.push(block);
      }
      case "permission-resolved": {
        const block = this.permissionBlocks.get(event.permissionId);
        if (block) Object.assign(block, { resolved: true, chosenOptionId: event.optionId });
        return;
      }
      case "acp":
        return this.addUpdate(origin, event.update);
    }
  }

  private addUpdate(origin: Origin, update: Extract<StoredEvent["event"], { type: "acp" }>["update"]) {
    const subagent = this.subagentOf(update);
    if (subagent) subagent.lastActivityAt = origin.at;
    const into = subagent?.blocks ?? this.blocks;
    switch (update.sessionUpdate) {
      case "user_message_chunk":
        return this.appendText("user", origin, contentText(update.content), into);
      case "agent_message_chunk":
        if (isInformational(update._meta)) return this.push({ kind: "info", ...origin, text: contentText(update.content) }, into);
        return this.appendText("agent", origin, contentText(update.content), into);
      case "agent_thought_chunk":
        return this.appendText("thought", origin, contentText(update.content), into);
      case "tool_call":
      case "tool_call_update":
        return this.upsertTool(origin, update, into);
      case "plan":
        if (subagent) return;
        if (this.currentPlan) {
          this.currentPlan.entries = update.entries;
          return;
        }
        this.currentPlan = { kind: "plan", ...origin, entries: update.entries };
        return this.push(this.currentPlan);
      case "current_mode_update":
        return this.push({ kind: "notice", ...origin, text: `Mode: ${update.currentModeId}` });
      default:
        return;
    }
  }

  /** The subagent that made the update, when its tool call is known. */
  private subagentOf(update: { _meta?: { [key: string]: unknown } | null }) {
    const { parentToolUseId } = claudeCodeMeta(update);
    return parentToolUseId ? this.toolBlocks.get(parentToolUseId)?.subagent : undefined;
  }

  private appendText(kind: TextBlockKind, origin: Origin, text: string, into: TimelineBlock[]) {
    const last = into.at(-1);
    if (last && last.kind === kind) {
      last.text += text;
      return;
    }
    this.push({ kind, ...origin, text }, into);
  }

  private upsertTool(origin: Origin, update: ToolCallUpdate & { title?: string | null }, into: TimelineBlock[]) {
    const existing = this.toolBlocks.get(update.toolCallId);
    const ends = update.status === "completed" || update.status === "failed";
    if (existing) {
      if (update.title) existing.title = update.title;
      if (update.kind) existing.toolKind = update.kind;
      if (update.status) existing.status = update.status;
      if (ends) existing.endedAt = origin.at;
      if (update.content) existing.content = update.content;
      if (update.locations) existing.locations = update.locations;
      if (update.rawInput !== undefined) existing.rawInput = update.rawInput;
      if (update.rawOutput !== undefined) existing.rawOutput = update.rawOutput;
      return;
    }
    const block: ToolBlock = {
      kind: "tool",
      ...origin,
      toolCallId: update.toolCallId,
      title: update.title ?? "Tool call",
      toolKind: update.kind,
      status: update.status,
      content: update.content ?? [],
      locations: update.locations ?? [],
      rawInput: update.rawInput,
      rawOutput: update.rawOutput,
      ...(ends && { endedAt: origin.at }),
    };
    const { toolName } = claudeCodeMeta(update);
    if (toolName) block.toolName = toolName;
    if (toolName && SUBAGENT_TOOLS.has(toolName)) {
      block.subagent = { blocks: [], lastActivityAt: origin.at, turnEnded: null };
      this.subagentsOfThisTurn.push(block.subagent);
    }
    this.toolBlocks.set(update.toolCallId, block);
    this.push(block, into);
  }

  private push(block: TimelineBlock, into = this.blocks) {
    into.push(block);
  }
}

export function buildTimeline(events: StoredEvent[]): TimelineBlock[] {
  const builder = new TimelineBuilder();
  events.forEach((event) => builder.add(event));
  return builder.blocks;
}
