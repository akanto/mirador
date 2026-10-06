import type {
  ContentBlock,
  PermissionOption,
  SessionUpdate,
  PlanEntry,
  StopReason,
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolCallUpdate,
  ToolKind,
} from "@agentclientprotocol/sdk";
import { jobWaitEndedNotice } from "./job-waits.ts";
import type { StoredEvent } from "./model.ts";
import { turnTitle } from "./reverts.ts";
import { UserCommandLog, type UserCommand } from "./user-commands.ts";

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
  /** Claude Code answered the call at once and left its subagent working on, as it does for subagents by default. */
  launchedInBackground?: true;
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
  (block.rawInput ?? {}) as { description?: unknown; subagent_type?: unknown; model?: unknown };

export const runsInBackground = (block: ToolBlock) => block.launchedInBackground === true;

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
  | (Origin & { kind: "user"; text: string; imageIds?: string[]; fromScript?: true; turnSeq?: number; filesKept?: true })
  | ToolBlock
  | PlanBlock
  | PermissionBlock
  | (Origin & { kind: "command"; command: UserCommand })
  | ErrorBlock;

/** `authRequired` until a sign-in started from the conversation succeeds, then `signedInSince`. */
type ErrorBlock = Origin & { kind: "error"; message: string; usageLimit?: true; authRequired?: true; signedInSince?: true };

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

const COALESCED_KEY = "mirador/coalesced";

/** Streamed chunks the host sends as one chunk: how many, and where and when the first one came. */
interface Coalesced {
  chunks: number;
  firstSeq: number;
  firstAt: number;
}

const coalescedIn = (update: { _meta?: { [key: string]: unknown } | null }) => (update._meta?.[COALESCED_KEY] as Coalesced | undefined) ?? null;

type Streamed = { text: string; chunks: number };

/** Some gateways follow a streamed message with one chunk that holds all of it again, under the message's id. */
const repeatsWhole = (streamed: Streamed, text: string) => streamed.chunks >= 2 && text.trim() !== "" && text === streamed.text;

class StreamedMessages {
  private readonly messages = new Map<string, Streamed>();

  soFar(messageId: string): Streamed {
    return this.messages.get(messageId) ?? { text: "", chunks: 0 };
  }

  /** Whether the text only repeats the message streamed so far; if not, it adds to the message. */
  repeats(messageId: string | null | undefined, text: string, chunks: number) {
    if (!messageId) return false;
    const streamed = this.soFar(messageId);
    const repeats = repeatsWhole(streamed, text);
    if (!repeats) this.messages.set(messageId, { text: streamed.text + text, chunks: streamed.chunks + chunks });
    return repeats;
  }
}

function claudeCodeMeta(update: { _meta?: { [key: string]: unknown } | null }) {
  const claudeCode = (update._meta?.claudeCode ?? {}) as { toolName?: unknown; parentToolUseId?: unknown; toolResponse?: { isAsync?: unknown } | null };
  return {
    toolName: typeof claudeCode.toolName === "string" ? claudeCode.toolName : undefined,
    parentToolUseId: typeof claudeCode.parentToolUseId === "string" ? claudeCode.parentToolUseId : undefined,
    launchedInBackground: claudeCode.toolResponse?.isAsync === true,
  };
}

/** A reply as short as "Done." can turn up inside an unrelated error message by chance. */
const SHORTEST_ERROR_ECHO = 16;

class TimelineBuilder {
  readonly blocks: TimelineBlock[] = [];
  private readonly toolBlocks = new Map<string, ToolBlock>();
  private readonly permissionBlocks = new Map<string, PermissionBlock>();
  private currentPlan: PlanBlock | null = null;
  private readonly subagentsOfThisTurn: Subagent[] = [];
  private readonly commands = new UserCommandLog();
  private readonly errorsAwaitingSignIn: ErrorBlock[] = [];
  private readonly streamedMessages = new StreamedMessages();
  /** What each turn began with, for the note a revert leaves. */
  private readonly messageTexts = new Map<number, string>();

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
        this.messageTexts.set(seq, event.text);
        return this.push({
          kind: "user",
          ...origin,
          text: event.text,
          ...(event.imageIds && { imageIds: event.imageIds }),
          ...(event.fromScript && { fromScript: event.fromScript }),
          ...(seq > 0 && { turnSeq: seq }),
          ...(event.checkpoint && { filesKept: true as const }),
        });
      case "revert":
        return this.push({
          kind: "notice",
          ...origin,
          text: `Files put back to how they were before the turn of “${this.messageAt(event.toSeq)}”`,
        });
      case "turn-end":
        this.endTurn(event.stopReason);
        if (event.stopReason === "end_turn") return;
        return this.push({ kind: "notice", ...origin, text: `Turn ended: ${event.stopReason.replaceAll("_", " ")}` });
      case "error": {
        this.endTurn("cancelled");
        this.dropAgentEchoOf(event.message);
        const block: ErrorBlock = {
          kind: "error",
          ...origin,
          message: event.message,
          ...(event.usageLimit && { usageLimit: true as const }),
          ...(event.authRequired && { authRequired: true as const }),
        };
        if (block.authRequired) this.errorsAwaitingSignIn.push(block);
        return this.push(block);
      }
      case "login-ended":
        if (event.signedIn) this.errorsAwaitingSignIn.splice(0).forEach((block) => (block.signedInSince = true));
        return this.push({ kind: "notice", ...origin, text: event.signedIn ? "Signed in. Send your message again." : "Signing in did not finish." });
      case "usage-limit-wait-stopped":
        return this.push({ kind: "notice", ...origin, text: "Stopped waiting for the usage limit to reset" });
      case "job-wait-ended":
        return this.push({ kind: "notice", ...origin, text: jobWaitEndedNotice(event.wait, event.end) });
      case "context-cleared":
        return this.push({ kind: "notice", ...origin, text: "Context cleared: the agent starts afresh" });
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
        return this.addUpdate(coalescedOrigin(event.update) ?? origin, event.update, at);
    }
  }

  /** The start of the message a turn began with, which a revert's note names; a turn not loaded yet has none. */
  private messageAt(seq: number) {
    return turnTitle(this.messageTexts.get(seq) ?? "");
  }

  private addUpdate(origin: Origin, update: SessionUpdate, at: number) {
    const subagent = this.subagentOf(update);
    if (subagent) subagent.lastActivityAt = at;
    const into = subagent?.blocks ?? this.blocks;
    switch (update.sessionUpdate) {
      case "user_message_chunk":
        return this.appendText("user", origin, contentText(update.content), into);
      case "agent_message_chunk":
        if (isInformational(update._meta)) return this.push({ kind: "info", ...origin, text: contentText(update.content) }, into);
        if (this.streamedMessages.repeats(update.messageId, contentText(update.content), coalescedIn(update)?.chunks ?? 1)) return;
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

  /** Whether the turn ended of its own accord, was stopped, or was cut short by an error: its subagents end with it. */
  private endTurn(stopReason: StopReason) {
    this.currentPlan = null;
    this.subagentsOfThisTurn.splice(0).forEach((subagent) => (subagent.turnEnded = stopReason));
  }

  /** Claude Code says an API error as the agent's message, and the failed prompt reports it again as an error. */
  private dropAgentEchoOf(errorMessage: string) {
    const last = this.blocks.at(-1);
    const echo = last?.kind === "agent" ? last.text.trim() : "";
    if (echo.length >= SHORTEST_ERROR_ECHO && errorMessage.includes(echo)) this.blocks.pop();
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
    const { toolName, launchedInBackground } = claudeCodeMeta(update);
    if (existing) {
      if (launchedInBackground) existing.launchedInBackground = true;
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
      ...(launchedInBackground && { launchedInBackground }),
    };
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

const coalescedOrigin = (update: SessionUpdate): Origin | null => {
  const coalesced = "_meta" in update ? coalescedIn(update) : null;
  return coalesced && { key: String(coalesced.firstSeq), at: coalesced.firstAt };
};

export function buildTimeline(events: StoredEvent[]): TimelineBlock[] {
  const builder = new TimelineBuilder();
  events.forEach((event) => builder.add(event));
  return builder.blocks;
}

type ChunkUpdate = Extract<SessionUpdate, { sessionUpdate: "agent_message_chunk" | "agent_thought_chunk" }>;

/** Streamed text of the reply or of the thinking, which may go out together with the chunks before it. */
function coalescibleChunk({ event }: StoredEvent): { update: ChunkUpdate; text: string } | null {
  if (event.type !== "acp") return null;
  const { update } = event;
  if (update.sessionUpdate !== "agent_message_chunk" && update.sessionUpdate !== "agent_thought_chunk") return null;
  return update.content.type === "text" && !isInformational(update._meta) ? { update, text: update.content.text } : null;
}

/** A chunk of the reply that the timeline checks for a repeat of the whole message. */
function countedChunk({ event }: StoredEvent): { messageId: string; text: string } | null {
  if (event.type !== "acp" || event.update.sessionUpdate !== "agent_message_chunk") return null;
  const { messageId, content, _meta } = event.update;
  return messageId && !isInformational(_meta) ? { messageId, text: contentText(content) } : null;
}

/** Consecutive chunks of one message, with nothing between them, that go out as one. */
class ChunkRun {
  private readonly texts: string[];
  private length: number;
  private last: StoredEvent;

  constructor(
    private readonly first: StoredEvent,
    private readonly update: ChunkUpdate,
    text: string,
    private readonly streamedBefore: Streamed | null,
  ) {
    this.texts = [text];
    this.length = text.length;
    this.last = first;
  }

  /** The timeline would read the run as a repeat of the whole message if it came to hold just that. */
  takes(update: ChunkUpdate, text: string) {
    const sameMessage =
      update.sessionUpdate === this.update.sessionUpdate && update.messageId === this.update.messageId && JSON.stringify(update._meta ?? null) === JSON.stringify(this.update._meta ?? null);
    return sameMessage && !this.wouldRepeatWhole(text);
  }

  private wouldRepeatWhole(text: string) {
    if (!this.streamedBefore || this.length + text.length !== this.streamedBefore.text.length) return false;
    return repeatsWhole(this.streamedBefore, this.texts.join("") + text);
  }

  add(stored: StoredEvent, text: string) {
    this.texts.push(text);
    this.length += text.length;
    this.last = stored;
  }

  /** Under the last chunk's number, so a phone that asks for what came after it gets none of them again. */
  asEvent(): StoredEvent {
    if (this.texts.length === 1) return this.first;
    const coalesced: Coalesced = { chunks: this.texts.length, firstSeq: this.first.seq, firstAt: this.first.at };
    const content = { ...(this.update.content as Extract<ContentBlock, { type: "text" }>), text: this.texts.join("") };
    return { seq: this.last.seq, at: this.last.at, event: { type: "acp", update: { ...this.update, content, _meta: { ...this.update._meta, [COALESCED_KEY]: coalesced } } } };
  }
}

/**
 * Agents stream their replies and thinking a few words per chunk, each stored as an event of its own; a long
 * conversation holds hundreds of thousands. Sent as one chunk per message, its history is a fraction of the size, and
 * its timeline the same. The events must start at a turn, so no message's chunks start before them.
 */
export function withChunksCoalesced(events: StoredEvent[]): StoredEvent[] {
  const coalesced: StoredEvent[] = [];
  const streamed = new StreamedMessages();
  let run: ChunkRun | null = null;
  const endRun = () => {
    if (run) coalesced.push(run.asEvent());
    run = null;
  };
  for (const stored of events) {
    const counted = countedChunk(stored);
    const streamedBefore = counted && streamed.soFar(counted.messageId);
    const chunk = coalescibleChunk(stored);
    const repeat = counted !== null && streamed.repeats(counted.messageId, counted.text, 1);
    if (!chunk || repeat) {
      endRun();
      coalesced.push(stored);
    } else if (run?.takes(chunk.update, chunk.text)) {
      run.add(stored, chunk.text);
    } else {
      endRun();
      run = new ChunkRun(stored, chunk.update, chunk.text, streamedBefore);
    }
  }
  endRun();
  return coalesced;
}
