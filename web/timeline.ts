import type {
  ContentBlock,
  PermissionOption,
  PlanEntry,
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
  | (Origin & { kind: "user" | "agent" | "thought" | "notice" | "info"; text: string })
  | ToolBlock
  | PlanBlock
  | PermissionBlock
  | (Origin & { kind: "command"; command: UserCommand })
  | (Origin & { kind: "error"; message: string });

export type Author = "user" | "agent";

export function authorOf(block: TimelineBlock | undefined): Author | null {
  if (!block || block.kind === "notice") return null;
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

class TimelineBuilder {
  readonly blocks: TimelineBlock[] = [];
  private readonly toolBlocks = new Map<string, ToolBlock>();
  private readonly permissionBlocks = new Map<string, PermissionBlock>();
  private currentPlan: PlanBlock | null = null;
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
        return this.push({ kind: "user", ...origin, text: event.text });
      case "turn-end":
        this.currentPlan = null;
        if (event.stopReason === "end_turn") return;
        return this.push({ kind: "notice", ...origin, text: `Turn ended: ${event.stopReason.replaceAll("_", " ")}` });
      case "error":
        return this.push({ kind: "error", ...origin, message: event.message });
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
    switch (update.sessionUpdate) {
      case "user_message_chunk":
        return this.appendText("user", origin, contentText(update.content));
      case "agent_message_chunk":
        if (isInformational(update._meta)) return this.push({ kind: "info", ...origin, text: contentText(update.content) });
        return this.appendText("agent", origin, contentText(update.content));
      case "agent_thought_chunk":
        return this.appendText("thought", origin, contentText(update.content));
      case "tool_call":
      case "tool_call_update":
        return this.upsertTool(origin, update);
      case "plan":
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

  private appendText(kind: TextBlockKind, origin: Origin, text: string) {
    const last = this.blocks.at(-1);
    if (last && last.kind === kind) {
      last.text += text;
      return;
    }
    this.push({ kind, ...origin, text });
  }

  private upsertTool(origin: Origin, update: ToolCallUpdate & { title?: string | null }) {
    const existing = this.toolBlocks.get(update.toolCallId);
    if (existing) {
      if (update.title) existing.title = update.title;
      if (update.kind) existing.toolKind = update.kind;
      if (update.status) existing.status = update.status;
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
    };
    this.toolBlocks.set(update.toolCallId, block);
    this.push(block);
  }

  private push(block: TimelineBlock) {
    this.blocks.push(block);
  }
}

export function buildTimeline(events: StoredEvent[]): TimelineBlock[] {
  const builder = new TimelineBuilder();
  events.forEach((event) => builder.add(event));
  return builder.blocks;
}
