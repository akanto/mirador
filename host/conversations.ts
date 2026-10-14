import { realpath } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import type * as acp from "@agentclientprotocol/sdk";
import {
  harnessLabels,
  harnessRewinds,
  type Activity,
  type AdoptMode,
  type AskMode,
  type ContextUsage,
  type Conversation,
  type ConversationEvent,
  type ConversationStatus,
  type ExternalSession,
  type HarnessId,
  type JobWait,
  type JobWaitEnd,
  type Launch,
  type PendingAsk,
  type PendingPermissionRequest,
  type PendingRequest,
  type QueuedMessage,
  type RestorePlan,
  type StoredEvent,
  type TerminalActivity,
  type UsageLimitWait,
  type WaitingFor,
  type Workspace,
} from "../shared/model.ts";
import { messageAtEnd, type JobWaitRequest } from "../shared/job-waits.ts";
import { panelCommandRun } from "../shared/panel-commands.ts";
import { historyEntry } from "../shared/prompt-history.ts";
import { inSidebarOrder, movedBefore } from "../shared/sidebar-order.ts";
import { isClearCommand, toSlashCommand } from "../shared/slash-commands.ts";
import { lastWordsOf } from "../shared/last-words.ts";
import { cutWithEllipsis, firstGraphemes } from "../shared/text-cut.ts";
import { canTryAgain } from "../shared/try-again.ts";
import { currentActivity, OpenToolCalls } from "./activity.ts";
import { editDiffsOf } from "./edit-diff.ts";
import { pendingAsk, pendingPermission } from "./pending-requests.ts";
import { launchIdea } from "./review/editor.ts";
import { mentionSuggestions } from "./mentions.ts";
import { PlanQuotasByProfile, reportedQuotas } from "./plan-quotas.ts";
import { turnEndReason, type TurnOutcome } from "../shared/system-notifications.ts";
import { hasBegun, updatesTheAgentRecords } from "../shared/conversation-begun.ts";
import { isUsageLimitError, usageLimitMessage, usageLimitResetIn } from "../shared/usage-limit.ts";
import { awaitingDelivery, userCommandsIn, withCommandOutputs, type UserCommand } from "../shared/user-commands.ts";
import { withChecklistNote, type ChecklistNote } from "./canvas/checklist.ts";
import { lastAgentMessageId, pendingReverts, rewindPointBefore, turnTitle, turnsFrom, withRevertNotes, type Revert } from "../shared/reverts.ts";
import { miradorCommandEnvironment } from "./acp/environment.ts";
import { CANVAS_SERVER_NAME, harnessSpec, isAuthRequiredError, launchEnvironment, loginCommand, profileEnvironment, sessionMeta } from "./acp/harnesses.ts";
import { HarnessProcess, type ConfigValue } from "./acp/harness.ts";
import type { HostConfig } from "./config.ts";
import type { Hub } from "./hub.ts";
import type { DroppedFiles } from "./dropped-files.ts";
import type { ImageStore } from "./images.ts";
import { followJobProgram, JobWaits } from "./job-waits.ts";
import type { NotifierMute } from "./notifier.ts";
import { Changes } from "./changes.ts";
import { Checkpoints, SNAPSHOTS_KEPT } from "./checkpoints.ts";
import { profileToLaunch } from "./profiles.ts";
import type { Store, UnseenTurnEnd } from "./store.ts";
import type { SystemNotifications } from "./system-notifications.ts";
import type { TerminalProgram } from "./terminals.ts";
import { claudeConfigDir } from "./terminal-sessions.ts";
import { TerminalWork, updatesAfter } from "./terminal-catch-up.ts";
import { claudeTranscript, lastAnsweringModel, modelChoiceFor, recordsUserMessage } from "./claude-transcript.ts";
import { UserCommandRunner } from "./user-commands.ts";
import { ConversationSessions } from "./conversation-sessions.ts";
import { SubagentSessions } from "./subagent-sessions.ts";
import { SubagentUsageReader } from "./subagent-usage.ts";
import { UnknownSessionUpdates } from "./unknown-session-updates.ts";

const UNTITLED = "New conversation";
const MAX_TITLE_LENGTH = 200;
const LISTED_SESSIONS = 30;
const TITLE_LENGTH = 60;
const CONTINUE_AFTER_INTERRUPTION = "Continue where you left off.";
const NO_FILES_KEPT = "Mirador kept no files for that turn, so there is nothing to undo it to.";
const AGENT_IS_WORKING = "The agent is still working. Stop its turn before going back.";
const NOT_A_TURN = "A conversation can be taken back only to one of your own messages.";
const AGENT_CANNOT_FORK = "The agent cannot be sent back to an earlier point in its session.";
const ONLY_CLAUDE_CODE_REWINDS = "Taking a conversation back needs the agent to leave part of its own session behind, which only Claude Code can do here.";
const ONLY_GIT_REPOSITORIES = "Mirador keeps a turn's files only in a workspace that is a git repository.";
const FILES_NO_LONGER_KEPT = `Mirador no longer keeps the files of that turn: it keeps those of a workspace's newest ${SNAPSHOTS_KEPT} turns.`;
const TURN_STOP_TIMEOUT_MS = 10_000;
/** Letting go of a session is a courtesy to its agent; one that doesn't answer must not hold up what comes next. */
const SESSION_CLOSE_TIMEOUT_MS = 5_000;
const OPTION_ANSWER_TIMEOUT_MS = 10_000;
/** Like Claude Code: the agent continues a minute after its usage limit resets, at most twice in a row by itself. */
const USAGE_LIMIT_RESET_MARGIN_MS = 60_000;
const AUTOMATIC_CONTINUES_IN_A_ROW = 2;
/** setTimeout fires at once when asked to wait longer than this, about 24.8 days. */
const LONGEST_TIMER_MS = 2 ** 31 - 1;

type PermissionResolver = (optionId: string | null) => void;

interface NotesForAgent {
  commands: UserCommand[];
  reverts: Revert[];
  checklist: ChecklistNote | null;
}

const NO_NOTES: NotesForAgent = { commands: [], reverts: [], checklist: null };

const withNotes = ({ commands, reverts, checklist }: NotesForAgent, text: string) =>
  withChecklistNote(checklist, withCommandOutputs(commands, withRevertNotes(reverts, text)));

interface PendingPermission {
  settle: PermissionResolver;
  allowOptionId: string | null;
  request: PendingPermissionRequest;
}

interface PromptStart {
  imageIds?: string[];
  fromScript?: boolean;
  /** A message of the user's starts a turn of its own, so the files are snapshotted and that turn can be undone. */
  startsTurn?: boolean;
}

interface Runtime {
  sessionId?: Promise<string>;
  harness?: HarnessProcess;
  running: boolean;
  /** Settles once the running turn has ended. */
  turnEnded?: Promise<void>;
  /** While a profile switch stops the running turn, queued messages wait for the new profile. */
  holdingQueue: boolean;
  /** The latest profile switch; the next one starts after it. */
  profileSwitch?: Promise<void>;
  pendingPermissions: Map<string, PendingPermission>;
  /** The latest permission request still reading the files it would edit; the next one shows after it. */
  permissionArriving?: Promise<unknown>;
  queuedMessages: QueuedMessage[];
  /** The latest steer still on its way to the agent; the next one goes after it, so messages join the turn in the order they were sent. */
  steering?: Promise<void>;
  openToolCalls: OpenToolCalls;
  usageLimit?: { wait: UsageLimitWait; timer?: ReturnType<typeof setTimeout> };
  /** How often in a row the agent continued by itself after a usage limit's reset, without a turn that succeeded. */
  automaticContinues: number;
  /** The host kills the agent process this turn runs on on purpose, so the turn ends as a stop, not as a failure. */
  killedOnPurpose?: boolean;
}

interface StoppedTurn {
  conversationId: string;
  sessionId: string | null;
}

export class ConversationService {
  private readonly runtimes = new Map<string, Runtime>();
  /** One agent process per profile, by its id. */
  private readonly harnessesByProfile = new Map<string, HarnessProcess>();
  private readonly sessions = new ConversationSessions();
  private readonly subagentSessions = new SubagentSessions();
  /** Sessions whose agent left an option change unanswered for too long, so their next changes don't wait. */
  private readonly sessionsSlowToAnswer = new Set<string>();
  private readonly updatesForUnknownSessions = new UnknownSessionUpdates();
  private readonly statusOverrides = new Map<string, Pick<Conversation, "status" | "statusDetail">>();
  private readonly terminalActivity = new Map<string, TerminalActivity>();
  private readonly terminalWork = new TerminalWork();
  private readonly catchingUpWithTerminal = new Set<string>();
  /** A session loaded again replays all of its history; it is held here, so only what the conversation lacks joins it. */
  private readonly replaysBeingRead = new Map<string, acp.SessionNotification[]>();
  private readonly contextUsage = new Map<string, ContextUsage>();
  private readonly planQuotas = new PlanQuotasByProfile();
  private readonly unseenTurnEnds: Map<string, UnseenTurnEnd>;
  private readonly lastWords = new Map<string, string>();
  private readonly asksWaitedOn: Map<string, PendingAsk>;
  private readonly commands = new UserCommandRunner();
  private readonly subagentUsageReader = new SubagentUsageReader();
  private readonly jobWaits: JobWaits;
  private readonly checkpoints: Checkpoints;
  readonly changes: Changes;
  /** While the host stops or restarts, messages wait in the queue for the next host, and turns it ends are not the agent's failures. */
  private stopping = false;
  private checklistNoteOf: (conversationId: string) => ChecklistNote | null = () => null;

  constructor(
    private readonly store: Store,
    private readonly hub: Hub,
    private readonly config: HostConfig,
    private readonly notifier: NotifierMute,
    private readonly images: ImageStore,
    private readonly droppedFiles: DroppedFiles,
    private readonly notifications: SystemNotifications,
  ) {
    this.checkpoints = new Checkpoints(config.dataDir);
    this.changes = new Changes(store, this.checkpoints, (conversationId) => this.workspaceOf(conversationId), launchIdea);
    this.cancelPermissionsOrphanedByRestart();
    this.endTurnsOrphanedByRestart();
    this.unseenTurnEnds = new Map(store.listUnseenTurnEnds());
    this.unseenTurnEnds.forEach((_, conversationId) => this.keepLastWords(conversationId));
    const waitingAsksOldestLast = store.listCanvasItemsWithStatus("waiting").sort((a, b) => b.createdAt - a.createdAt);
    this.asksWaitedOn = new Map(waitingAsksOldestLast.map((item) => [item.conversationId, pendingAsk(item)]));
    this.jobWaits = new JobWaits(store, {
      changed: (conversationId) => this.republish(conversationId),
      ended: (conversationId, wait, end) => this.jobWaitEnded(conversationId, wait, end),
    });
  }

  list(): Conversation[] {
    return this.store.listConversations().map((conversation) => this.withRuntimeStatus(conversation));
  }

  waitingCount(): number {
    return [...this.conversationsThatMayWait()].filter((conversationId) => this.waitingFor(conversationId) !== null).length;
  }

  runningTurnsCount(): number {
    return [...this.runtimes.values()].filter((runtime) => runtime.running).length;
  }

  get(conversationId: string): Conversation {
    const conversation = this.store.findConversation(conversationId);
    if (!conversation) throw new Error(`Unknown conversation ${conversationId}`);
    return this.withRuntimeStatus(conversation);
  }

  planQuotasOf(conversationId: string, now: number) {
    return this.planQuotas.of(this.get(conversationId).profileId, now);
  }

  slashCommands(conversationId: string) {
    return this.store.latestAvailableCommands(this.get(conversationId)).map(toSlashCommand);
  }

  typedElsewhere(conversationId: string) {
    const { id, workspaceId } = this.get(conversationId);
    return this.store.typedInWorkspace(workspaceId, id).flatMap((event) => historyEntry(event)?.text ?? []);
  }

  typedEarlierIn(conversationId: string, beforeSeq: number) {
    return this.store.typedBefore(this.get(conversationId).id, beforeSeq).flatMap((event) => historyEntry(event) ?? []);
  }

  async mentionSuggestions(conversationId: string, query: string) {
    return mentionSuggestions(this.existingWorkspace(this.get(conversationId).workspaceId).path, query);
  }

  /** What the conversation's subagents spent so far, from Claude Code's transcripts of them. */
  async subagentUsage(conversationId: string, toolCallIds: string[]) {
    const conversation = this.get(conversationId);
    if (conversation.harness !== "claude" || !conversation.acpSessionId) return {};
    return this.subagentUsageReader.usageOf(this.claudeConfigDirOf(conversation), conversation.acpSessionId, toolCallIds);
  }

  create(workspaceId: string, launch: Launch): Conversation {
    const conversation = this.insertConversation(workspaceId, launch, UNTITLED);
    this.ensureSession(conversation.id).catch(() => {});
    return conversation;
  }

  /** The newest sessions the harness knows for the workspace directory, including ones started outside the app. */
  async listSessionsInWorkspace(workspaceId: string, launch: Launch): Promise<ExternalSession[]> {
    const directory = await recordedDirectory(this.existingWorkspace(workspaceId));
    profileToLaunch(this.store, launch);
    const harness = this.harnessFor(launch);
    const capabilities = await harness.start();
    if (!capabilities.agentCapabilities?.sessionCapabilities?.list) throw new Error(`${harness.spec.label} cannot list its sessions.`);
    const { sessions } = await harness.listSessions(directory);
    const conversationIdBySession = new Map(this.store.listConversations().map(({ acpSessionId, id }) => [acpSessionId, id]));
    return sessions
      .filter(({ cwd }) => cwd === directory)
      .slice(0, LISTED_SESSIONS)
      .map(({ sessionId, title, updatedAt }) => ({
        sessionId,
        title: title ?? null,
        updatedAt: updatedAt ?? null,
        conversationId: conversationIdBySession.get(sessionId) ?? null,
      }));
  }

  /** Continues (or forks) a session started elsewhere, e.g. in a terminal, replaying its history into the conversation. */
  adopt(workspaceId: string, launch: Launch, session: Pick<ExternalSession, "sessionId" | "title">, mode: AdoptMode): Conversation {
    if (mode === "continue" && this.store.listConversations().some(({ acpSessionId }) => acpSessionId === session.sessionId)) {
      throw new Error("That session is already open in the app.");
    }
    const title = session.title || UNTITLED;
    const conversation = this.insertConversation(workspaceId, launch, mode === "fork" ? `Fork: ${title}` : title);
    this.ensureSession(conversation.id, () => this.loadExternalSession(conversation.id, session.sessionId, mode)).catch(() => {});
    return conversation;
  }

  private insertConversation(workspaceId: string, launch: Launch, title: string): Conversation {
    this.existingWorkspace(workspaceId);
    const profile = profileToLaunch(this.store, launch);
    const now = Date.now();
    const conversation = this.store.insertConversation({
      id: crypto.randomUUID(),
      workspaceId,
      harness: launch.harness,
      profileId: launch.profileId,
      title,
      titleSetByUser: false,
      acpSessionId: null,
      askMode: profile.askMode,
      bypassPermissions: profile.bypassPermissions,
      status: "idle",
      statusDetail: null,
      openInTerminal: null,
      contextUsage: null,
      queuedMessages: [],
      usageLimit: null,
      jobWaits: [],
      waitingFor: null,
      pendingRequest: null,
      lastWords: null,
      activity: null,
      configOptions: [],
      createdAt: now,
      updatedAt: now,
    });
    this.publish(conversation);
    return conversation;
  }

  /** Reorders the conversation among its workspace's; the others it shifts are published too. */
  move(conversationId: string, beforeConversationId: string | null) {
    const { workspaceId } = this.get(conversationId);
    const siblings = this.store
      .listConversations()
      .filter((conversation) => conversation.workspaceId === workspaceId)
      .sort(inSidebarOrder);
    this.store.setConversationOrder(movedBefore(siblings.map(({ id }) => id), conversationId, beforeConversationId));
    const positionBefore = new Map(siblings.map(({ id, position }) => [id, position]));
    this.store
      .listConversations()
      .filter(({ id, position }) => positionBefore.has(id) && positionBefore.get(id) !== position)
      .forEach((conversation) => this.publish(conversation));
  }

  delete(conversationId: string) {
    const conversation = this.get(conversationId);
    if (conversation.acpSessionId) {
      this.cancel(conversationId).catch(() => {});
      this.notifier.unmute(conversation.acpSessionId);
    }
    this.sessions.forget(conversationId);
    this.subagentSessions.forget(conversationId);
    const runtime = this.runtimes.get(conversationId);
    const wasRunning = runtime?.running ?? false;
    if (runtime) this.endUsageLimitWait(runtime);
    this.jobWaits.forget(conversationId);
    this.runtimes.delete(conversationId);
    this.statusOverrides.delete(conversationId);
    this.terminalActivity.delete(conversationId);
    this.contextUsage.delete(conversationId);
    this.unseenTurnEnds.delete(conversationId);
    this.lastWords.delete(conversationId);
    this.asksWaitedOn.delete(conversationId);
    this.store.deleteConversation(conversationId);
    this.images.deleteConversation(conversationId);
    this.droppedFiles.deleteConversation(conversationId);
    this.hub.broadcast({ type: "conversation.deleted", conversationId });
    this.announceWaitingCount();
    if (wasRunning) this.announceRunningTurnsCount();
  }

  deleteAllInWorkspace(workspaceId: string) {
    this.store
      .listConversations()
      .filter((conversation) => conversation.workspaceId === workspaceId)
      .forEach((conversation) => this.delete(conversation.id));
  }

  rename(conversationId: string, title: string) {
    const name = firstGraphemes(title.trim(), MAX_TITLE_LENGTH);
    if (!name) throw new Error("A conversation needs a name.");
    this.save({ ...this.get(conversationId), title: name, titleSetByUser: true });
  }

  /**
   * Moves the conversation's session to the agent process of another profile of its agent. A turn in progress
   * is stopped first and, once the session is back, continued under the new profile; queued messages follow.
   * A conversation that has not begun may move to another agent's profile, in a fresh session of that agent.
   */
  setProfile(conversationId: string, profileId: string) {
    const runtime = this.runtime(conversationId);
    const switched = (runtime.profileSwitch ?? Promise.resolve()).then(() => this.switchProfile(conversationId, profileId));
    runtime.profileSwitch = switched.catch(() => {});
    return switched;
  }

  private async switchProfile(conversationId: string, profileId: string) {
    const runtime = this.runtime(conversationId);
    await runtime.sessionId?.catch(() => {});
    if (this.get(conversationId).profileId === profileId) return;
    const harness = this.agentToSwitchTo(conversationId, profileId);
    const changesAgent = harness !== this.get(conversationId).harness;
    const profile = profileToLaunch(this.store, { harness, profileId });
    const interrupted = runtime.running;
    runtime.holdingQueue = interrupted;
    if (interrupted) await this.stopTurnEvenIfIgnored(conversationId);
    const conversation = this.get(conversationId);
    const released = this.releaseSession(runtime, conversation.acpSessionId);
    if (changesAgent) this.contextUsage.delete(conversationId);
    this.save({
      ...conversation,
      harness,
      profileId,
      askMode: profile.askMode,
      bypassPermissions: profile.bypassPermissions,
      acpSessionId: !changesAgent && this.agentHasRecorded(conversationId) ? conversation.acpSessionId : null,
      configOptions: changesAgent ? [] : conversation.configOptions.filter(({ id }) => id !== "model"),
    });
    this.append(conversationId, { type: "profile-changed", profileName: profile.name, ...(changesAgent && { agent: harness }) });
    this.ensureSession(conversationId, async () => {
      this.setStatus(conversationId, "starting", "Switching profile…");
      await released;
      const sessionId = await this.openSession(conversationId);
      await this.applyProfileMode(conversationId, sessionId);
      this.setStatus(conversationId, "idle");
      return sessionId;
    })
      .finally(() => (runtime.holdingQueue = false))
      .then(() => {
        if (runtime.running) return;
        if (interrupted) return this.resumeStoppedTurn(conversationId, conversation.acpSessionId);
        this.sendNextQueuedMessage(conversationId);
      })
      .catch(() => {});
  }

  /** The profile's own agent, which only a conversation that has not begun may move to. */
  private agentToSwitchTo(conversationId: string, profileId: string): HarnessId {
    const { harness } = this.get(conversationId);
    const target = this.store.findProfile(profileId);
    if (!target || target.harness === harness || !hasBegun(this.store.listEvents(conversationId))) return target?.harness ?? harness;
    throw new Error(`This conversation already runs on ${harnessLabels[harness]}. Start a new conversation to use “${target.name}” on ${harnessLabels[target.harness]}.`);
  }

  /** Like /clear in Claude Code: the agent goes on in a fresh session, while the conversation so far stays on screen. */
  private async clearContext(conversationId: string) {
    const runtime = this.runtime(conversationId);
    await runtime.sessionId?.catch(() => {});
    const released = this.releaseSession(runtime, this.get(conversationId).acpSessionId);
    this.contextUsage.delete(conversationId);
    this.save({ ...this.get(conversationId), acpSessionId: null });
    this.append(conversationId, { type: "context-cleared" });
    await this.ensureSession(conversationId, async () => {
      this.setStatus(conversationId, "starting", "Clearing the context…");
      await released;
      const sessionId = await this.openSession(conversationId);
      this.setStatus(conversationId, "idle");
      return sessionId;
    }).catch(() => {});
    this.sendNextQueuedMessage(conversationId);
  }

  /** A turn whose agent cannot take the cancel, such as one still starting, is waited for all the same. */
  private async stopTurn(conversationId: string) {
    const { turnEnded } = this.runtime(conversationId);
    await this.cancel(conversationId).catch((error) => console.error(`${new Date().toISOString()} cancelling the turn failed; waiting for it to end:`, error));
    await turnEnded;
  }

  /** An agent that ignores the cancel has its process killed after a while, as Force stop would. */
  private async stopTurnEvenIfIgnored(conversationId: string) {
    const stopped = await Promise.race([this.stopTurn(conversationId).then(() => true), Bun.sleep(TURN_STOP_TIMEOUT_MS).then(() => false)]);
    if (!stopped) await this.forceCancel(conversationId);
  }

  setAskMode(conversationId: string, askMode: AskMode) {
    this.save({ ...this.get(conversationId), askMode });
  }

  /** Switching YOLO on also approves the requests already waiting for the user. */
  setBypassPermissions(conversationId: string, bypassPermissions: boolean) {
    this.save({ ...this.get(conversationId), bypassPermissions });
    if (!bypassPermissions) return;
    this.runtime(conversationId).pendingPermissions.forEach(({ settle, allowOptionId }) => allowOptionId && settle(allowOptionId));
  }

  async setConfigOption(conversationId: string, configId: string, value: ConfigValue) {
    const sessionId = await this.ensureSession(conversationId);
    const response = await this.harnessFor(this.get(conversationId)).setConfigOption(sessionId, configId, value);
    this.save({ ...this.get(conversationId), configOptions: response.configOptions });
  }

  async prompt(conversationId: string, text: string, { imageIds = [], fromScript = false, startsTurn = false }: PromptStart = {}) {
    const runtime = this.runtime(conversationId);
    if (runtime.running) throw new Error("The agent is still working on the previous message.");
    if (isClearCommand(text)) return this.clearContext(conversationId);
    runtime.running = true;
    this.announceRunningTurnsCount();
    this.endUsageLimitWait(runtime);
    let endTurn = () => {};
    runtime.turnEnded = new Promise((resolve) => (endTurn = resolve));
    runtime.openToolCalls.clear();
    this.forgetUnseenTurnEnd(conversationId);
    this.retitleFromFirstMessage(conversationId, text);
    const notes = this.notesForAgent(conversationId);
    this.setStatus(conversationId, "starting");
    const checkpoint = startsTurn ? await this.snapshotFiles(conversationId) : null;
    this.store.turnStarted(conversationId);
    this.appendUserMessage(conversationId, { text, imageIds, ...(fromScript && { fromScript }), ...(checkpoint && { checkpoint }) }, notes);
    let promptSent = false;
    try {
      const sessionId = await this.ensureSession(conversationId);
      this.setStatus(conversationId, "running");
      const prompt = await this.promptContent(conversationId, withNotes(notes, text), imageIds);
      const harness = this.harnessFor(this.get(conversationId));
      promptSent = true;
      const response = await harness.prompt(sessionId, prompt);
      this.append(conversationId, { type: "turn-end", stopReason: response.stopReason });
      runtime.automaticContinues = 0;
      this.notifyTurnEnded(conversationId, { stopReason: response.stopReason });
    } catch (error) {
      if (runtime.killedOnPurpose) {
        this.append(conversationId, { type: "turn-end", stopReason: "cancelled" });
        this.notifyTurnEnded(conversationId, { stopReason: "cancelled" });
      } else {
        this.notifyTurnEnded(conversationId, { error: this.recordTurnFailure(conversationId, error, promptSent) });
      }
    } finally {
      runtime.running = false;
      this.announceRunningTurnsCount();
      runtime.killedOnPurpose = false;
      this.store.turnEnded(conversationId);
      this.setStatus(conversationId, "idle");
      endTurn();
    }
    this.sendNextQueuedMessage(conversationId);
  }

  /**
   * Sends `text` as the next user message, after those already waiting in the queue, such as the ones behind a /clear
   * that is opening the fresh session. While a turn is running it joins the turn: at once, cutting off what the agent is
   * writing, or, while the agent waits on tools, once they have finished. Sent `afterTurn`, it waits in the queue for the
   * turn to end.
   */
  async send(conversationId: string, text: string, imageIds: string[] = [], { fromScript = false, afterTurn = false } = {}) {
    const runtime = this.runtime(conversationId);
    const sendsAtOnce = !runtime.running && !this.stopping && !runtime.usageLimit && runtime.queuedMessages.length === 0;
    if (sendsAtOnce) return this.prompt(conversationId, text, { imageIds, fromScript, startsTurn: true });
    const message: QueuedMessage = { id: crypto.randomUUID(), text, imageIds, ...(fromScript && { fromScript }), ...(afterTurn && { afterTurn }) };
    this.setQueue(conversationId, runtime, [...runtime.queuedMessages, message]);
    this.publish(this.get(conversationId));
    if (!runtime.running) this.sendNextQueuedMessage(conversationId);
    else if (!afterTurn) this.steerQueuedMessages(conversationId);
  }

  /** What undoing the turn that began with this message would do to the files, or why it cannot be undone. */
  async previewRevert(conversationId: string, seq: number): Promise<{ plan: RestorePlan | null; cannotUndo?: string }> {
    const checkpoint = this.checkpointAt(conversationId, seq);
    if (!checkpoint) return { plan: null, cannotUndo: NO_FILES_KEPT };
    const plan = await this.checkpoints.preview(this.workspaceOf(conversationId), checkpoint);
    if (!plan) return { plan: null, cannotUndo: ONLY_GIT_REPOSITORIES };
    return (await this.checkpoints.keeps(this.workspaceOf(conversationId), checkpoint)) ? { plan } : { plan: null, cannotUndo: FILES_NO_LONGER_KEPT };
  }

  /**
   * Puts the workspace's files back to how they were before the turn that began with this message, deleting what came
   * after it. The conversation itself stays as it is, so the agent's context and its cache survive whole; the note
   * saying what happened goes out with the user's next message.
   */
  async revert(conversationId: string, seq: number): Promise<RestorePlan> {
    if (this.runtime(conversationId).running) throw new Error("The agent is still working. Stop its turn before undoing one.");
    const checkpoint = this.checkpointAt(conversationId, seq);
    if (!checkpoint) throw new Error(NO_FILES_KEPT);
    if (!(await this.checkpoints.keeps(this.workspaceOf(conversationId), checkpoint))) throw new Error(FILES_NO_LONGER_KEPT);
    const plan = await this.checkpoints.restore(this.workspaceOf(conversationId), checkpoint);
    this.append(conversationId, { type: "revert", revertId: crypto.randomUUID(), toSeq: seq, ...plan });
    return plan;
  }

  /**
   * What rewinding to this turn would do: the conversation loses its turns from here on, and the files go back to how
   * they were when the turn began. `filesNote` says why the files will be left alone, when they will be.
   */
  async previewRewind(conversationId: string, seq: number): Promise<{ turnsLeaving: number; keptFrom: string | null; plan: RestorePlan | null; cannotRewind?: string; filesNote?: string }> {
    const events = this.store.listEvents(conversationId);
    const turnsLeaving = turnsFrom(events, seq).length;
    const before = events.filter(({ seq: at, event }) => at < seq && event.type === "user-message");
    const kept = before.at(-1)?.event;
    const keptFrom = kept?.type === "user-message" ? turnTitle(kept.text) : null;
    const cannotRewind = this.rewindProblem(conversationId, seq);
    if (cannotRewind) return { turnsLeaving, keptFrom, plan: null, cannotRewind };
    const { plan, cannotUndo } = await this.previewRevert(conversationId, seq);
    return { turnsLeaving, keptFrom, plan, ...(cannotUndo && { filesNote: cannotUndo }) };
  }

  /**
   * Takes the conversation, the workspace's files and the agent's session back to how they were before the turn that
   * began with the message at `seq`. The agent goes on in a session forked so that it holds only what came before —
   * the prefix is the same bytes it was, so the agent's cached context still counts — and the events from there on are
   * dropped, which leaves what the agent has and what the user sees the same.
   */
  async rewind(conversationId: string, seq: number): Promise<{ fromSeq: number }> {
    const cannotRewind = this.rewindProblem(conversationId, seq);
    if (cannotRewind) throw new Error(cannotRewind);
    const runtime = this.runtime(conversationId);
    const conversation = this.get(conversationId);
    const point = rewindPointBefore(this.store.listEvents(conversationId), seq);
    this.setStatus(conversationId, "starting", "Going back…");
    try {
      const forked = point && conversation.acpSessionId ? await this.forkSessionAt(conversationId, point) : null;
      const checkpoint = this.checkpointAt(conversationId, seq);
      if (checkpoint && (await this.checkpoints.keeps(this.workspaceOf(conversationId), checkpoint))) await this.checkpoints.restore(this.workspaceOf(conversationId), checkpoint);
      const released = this.releaseSession(runtime, conversation.acpSessionId);
      this.store.deleteEventsFrom(conversationId, seq);
      this.contextUsage.delete(conversationId);
      this.save({ ...this.get(conversationId), acpSessionId: forked });
      this.hub.publishToConversation(conversationId, { type: "conversation.rewound", conversationId, fromSeq: seq });
      await released;
      return { fromSeq: seq };
    } finally {
      this.setStatus(conversationId, "idle");
    }
  }

  /**
   * A copy of the agent's session that holds only what it had said up to `point`. The fork point is named the way
   * claude-agent-acp asks for it, in `_meta.jetbrains.air.fork`; an agent that ignores it forks the whole session, so
   * `harnessRewinds` keeps those agents out of here.
   */
  private async forkSessionAt(conversationId: string, point: string) {
    const conversation = this.get(conversationId);
    const harness = this.harnessFor(conversation);
    this.runtime(conversationId).harness = harness;
    const capabilities = await harness.start();
    if (!capabilities.agentCapabilities?.sessionCapabilities?.fork) throw new Error(AGENT_CANNOT_FORK);
    const { sessionId } = await harness.forkSession({
      sessionId: conversation.acpSessionId!,
      cwd: await recordedDirectory(this.existingWorkspace(conversation.workspaceId)),
      _meta: { jetbrains: { air: { fork: { version: 1, messageId: point } } } },
    });
    return sessionId;
  }

  /** Why the conversation cannot go back to this turn, if it cannot. */
  private rewindProblem(conversationId: string, seq: number) {
    if (this.runtime(conversationId).running) return AGENT_IS_WORKING;
    if (this.store.findEvent(conversationId, seq)?.event.type !== "user-message") return NOT_A_TURN;
    const point = rewindPointBefore(this.store.listEvents(conversationId), seq);
    if (!point) return undefined; // The agent holds nothing of what came before, so a fresh session says the same.
    return harnessRewinds[this.get(conversationId).harness] ? undefined : ONLY_CLAUDE_CODE_REWINDS;
  }

  private checkpointAt(conversationId: string, seq: number) {
    const event = this.store.findEvent(conversationId, seq)?.event;
    return event?.type === "user-message" ? event.checkpoint : undefined;
  }

  private workspaceOf(conversationId: string) {
    return this.existingWorkspace(this.get(conversationId).workspaceId);
  }

  /** A turn works without this, so a failure costs that turn its undo and nothing else. */
  private async snapshotFiles(conversationId: string) {
    try {
      return await this.checkpoints.snapshot(this.workspaceOf(conversationId));
    } catch (error) {
      console.error(`${new Date().toISOString()} could not keep the files of a turn: ${errorMessage(error)}`);
      return null;
    }
  }

  /** Continues before the usage limit's reset, e.g. after switching to a profile that signs in to another account. */
  continueAfterUsageLimit(conversationId: string, { automatically = false } = {}) {
    const runtime = this.runtime(conversationId);
    if (!runtime.usageLimit || this.stopping) return;
    runtime.automaticContinues = automatically ? runtime.automaticContinues + 1 : 0;
    this.prompt(conversationId, CONTINUE_AFTER_INTERRUPTION).catch(() => {});
  }

  /** The agent still holds the message its failed turn began with, so trying again asks it to continue. */
  tryAgainAfterError(conversationId: string, errorSeq: number) {
    if (this.runtime(conversationId).running || this.stopping) return;
    if (!canTryAgain(this.store.listEventsFrom(conversationId, errorSeq), errorSeq)) return;
    this.prompt(conversationId, CONTINUE_AFTER_INTERRUPTION).catch(() => {});
  }

  /** The agent does not continue by itself after all; messages queued meanwhile go out now. */
  stopWaitingForUsageLimit(conversationId: string) {
    if (!this.endUsageLimitWait(this.runtime(conversationId))) return;
    this.append(conversationId, { type: "usage-limit-wait-stopped" });
    this.publish(this.get(conversationId));
    this.sendNextQueuedMessage(conversationId);
  }

  /** `mirador when-done`: once the job ends, the agent gets the message as your next one, or only you are told. */
  waitForJob(conversationId: string, request: JobWaitRequest) {
    return this.jobWaits.add(conversationId, request);
  }

  stopWaitingForJob(conversationId: string, waitId: string) {
    const wait = this.jobWaits.stop(conversationId, waitId);
    if (wait) this.append(conversationId, { type: "job-wait-ended", wait, end: "stopped" });
  }

  /** A terminal tab that shows what the job runs and follows its output. */
  jobFollowProgram(conversationId: string, waitId: string): TerminalProgram {
    const wait = this.jobWaits.in(conversationId).find(({ id }) => id === waitId);
    if (!wait) throw new Error("Mirador no longer waits for that job.");
    return followJobProgram(wait);
  }

  private jobWaitEnded(conversationId: string, wait: JobWait, end: Exclude<JobWaitEnd, "stopped">) {
    this.append(conversationId, { type: "job-wait-ended", wait, end });
    const message = messageAtEnd(wait, end);
    if (wait.resume) this.send(conversationId, message, [], { fromScript: true }).catch(() => {});
    else this.notifications.notify(conversationId, { kind: "job-ended", message });
  }

  /** A focused window shows the conversation, so the turn that ended there has been seen. */
  markSeen(conversationId: string) {
    if (this.forgetUnseenTurnEnd(conversationId)) this.republish(conversationId);
  }

  /** The canvas reports each question it opens, has answered or withdraws. */
  questionsChanged(conversationId: string) {
    const waiting = this.store.listCanvasItems(conversationId).find(({ status }) => status === "waiting");
    if (waiting) this.asksWaitedOn.set(conversationId, pendingAsk(waiting));
    else this.asksWaitedOn.delete(conversationId);
    if (this.store.hasConversation(conversationId)) this.publish(this.get(conversationId));
  }

  /** Runs a `!` command from the message box in the conversation's workspace, with the environment its agent gets. */
  runCommand(conversationId: string, command: string) {
    const conversation = this.get(conversationId);
    const directory = this.store.findWorkspace(conversation.workspaceId)?.path;
    if (!directory) throw new Error("This conversation's workspace no longer exists.");
    const environment = profileEnvironment(this.profileOf(conversation));
    void this.commands.run(command, directory, environment, (event) => this.append(conversationId, event));
  }

  /** A command the host no longer runs (it was restarted meanwhile) is marked as stopped, so its card stops waiting. */
  stopCommand(conversationId: string, commandId: string) {
    if (this.commands.isRunning(commandId)) return this.commands.stop(commandId);
    const orphaned = userCommandsIn(this.store.listEvents(conversationId)).some((command) => command.commandId === commandId && !command.ended);
    if (orphaned) this.append(conversationId, { type: "user-command-ended", commandId, exitCode: null });
  }

  dropCommandOutputs(conversationId: string, commandIds: string[]) {
    if (commandIds.length > 0) this.append(conversationId, { type: "user-command-dropped", commandIds });
  }

  editQueuedMessage(conversationId: string, messageId: string, text: string) {
    if (!text.trim()) return this.removeQueuedMessage(conversationId, messageId);
    this.replaceQueue(conversationId, (queue) => queue.map((message) => (message.id === messageId ? { ...message, text } : message)), messageId);
  }

  setQueuedMessageAfterTurn(conversationId: string, messageId: string, afterTurn: boolean) {
    const switched = ({ afterTurn: _, ...message }: QueuedMessage): QueuedMessage => ({ ...message, ...(afterTurn && { afterTurn }) });
    this.replaceQueue(conversationId, (queue) => queue.map((message) => (message.id === messageId ? switched(message) : message)), messageId);
    if (!afterTurn) this.steerQueuedMessages(conversationId);
  }

  /** The agent's own sign-in, with the environment of the conversation's profile, so a profile with its own account signs that one in. */
  loginProgram(conversationId: string): TerminalProgram {
    const conversation = this.get(conversationId);
    const environment = launchEnvironment(conversation.harness, this.profileOf(conversation), this.store.claudeProgramSetting());
    return { tabName: `${harnessLabels[conversation.harness]} sign-in`, command: loginCommand(conversation.harness, environment), environment };
  }

  /** A command Claude Code shows a panel for only in its own terminal, run in a tab of the conversation's terminals. */
  panelCommandProgram(conversationId: string, line: string): TerminalProgram {
    const command = panelCommandRun(line);
    if (command === null) throw new Error(`${line} is not a slash command.`);
    const conversation = this.get(conversationId);
    if (conversation.harness !== "claude") throw new Error(`${harnessLabels[conversation.harness]} has no command like ${line}.`);
    const environment = launchEnvironment(conversation.harness, this.profileOf(conversation), this.store.claudeProgramSetting());
    return { tabName: command, command: [environment.CLAUDE_CODE_EXECUTABLE!, command], environment, key: `panel ${command}` };
  }

  loginEnded(conversationId: string, signedIn: boolean) {
    if (this.store.hasConversation(conversationId)) this.append(conversationId, { type: "login-ended", signedIn });
  }

  /** Messages leave the queue from the front, so this changes when one goes out. */
  moveQueuedMessage(conversationId: string, messageId: string, beforeMessageId: string | null) {
    this.replaceQueue(
      conversationId,
      (queue) => {
        const byId = new Map(queue.map((message) => [message.id, message]));
        return movedBefore([...byId.keys()], messageId, beforeMessageId).map((id) => byId.get(id)!);
      },
      messageId,
    );
  }

  /** Images pasted into the message box but left out of what was sent; one that a message carried or a queued one carries stays. */
  discardImages(conversationId: string, imageIds: string[]) {
    if (!this.store.hasConversation(conversationId)) return;
    const carried = new Set([...this.store.sentImageIds(conversationId), ...this.runtime(conversationId).queuedMessages.flatMap((message) => message.imageIds)]);
    imageIds.filter((imageId) => !carried.has(imageId)).forEach((imageId) => this.images.delete(conversationId, imageId));
  }

  removeQueuedMessage(conversationId: string, messageId: string) {
    this.replaceQueue(conversationId, (queue) => queue.filter(({ id }) => id !== messageId), messageId);
  }

  async cancel(conversationId: string, { force = false } = {}): Promise<void> {
    if (force) return this.forceCancel(conversationId);
    const runtime = this.runtime(conversationId);
    runtime.pendingPermissions.forEach(({ settle }) => settle(null));
    const conversation = this.get(conversationId);
    if (runtime.running && conversation.acpSessionId) {
      await this.harnessFor(conversation).cancel(conversation.acpSessionId);
    }
  }

  /**
   * Unwedges a turn the agent won't cancel (e.g. its model request is blocked) by killing the shared agent process.
   * Siblings on the same process lose their turn too, so they continue where they left off; the conversation the user
   * force-stopped stays stopped.
   */
  private async forceCancel(conversationId: string): Promise<void> {
    const harness = this.runtime(conversationId).harness;
    if (!harness) return this.cancel(conversationId);
    const stopped = await this.killAgent(harness, "was force stopped");
    this.continueStoppedTurns(stopped.filter((turn) => turn.conversationId !== conversationId));
  }

  /**
   * Every turn the kill ends is the host's doing rather than the agent's failure, so each ends the way a stop ends it.
   * Returns those turns once they all have ended.
   */
  private async killAgent(harness: HarnessProcess, reason: string): Promise<StoppedTurn[]> {
    const running = [...this.runtimes].filter(([, runtime]) => runtime.harness === harness && runtime.running);
    running.forEach(([, runtime]) => (runtime.killedOnPurpose = true));
    const stopped = running.map(([conversationId]) => ({ conversationId, sessionId: this.get(conversationId).acpSessionId }));
    await harness.stop(reason);
    await Promise.all(running.map(([, runtime]) => runtime.turnEnded));
    return stopped;
  }

  /** As after a restart, on a fresh agent process. */
  private continueStoppedTurns(turns: StoppedTurn[]) {
    turns.forEach(({ conversationId, sessionId }) => this.resumeStoppedTurn(conversationId, sessionId).catch(() => {}));
  }

  respondToPermission(conversationId: string, permissionId: string, optionId: string | null) {
    const pending = this.runtime(conversationId).pendingPermissions.get(permissionId);
    if (!pending) throw new Error("This permission request is no longer pending.");
    pending.settle(optionId);
  }

  /** Where the conversations' Claude Code sessions are registered; a profile may set its own config directory. */
  claudeConfigDirs(): string[] {
    return this.store
      .listConversations()
      .filter(({ harness, acpSessionId }) => harness === "claude" && acpSessionId !== null)
      .map((conversation) => this.claudeConfigDirOf(conversation));
  }

  /** Marks conversations whose Claude Code session is also open in a terminal, e.g. one continued from there. */
  showTerminalActivity(activityBySession: Map<string, TerminalActivity>) {
    this.store.listConversations().forEach((conversation) => {
      const activity = (conversation.harness === "claude" && conversation.acpSessionId && activityBySession.get(conversation.acpSessionId)) || null;
      if (this.terminalWork.seen(conversation.id, activity)) void this.catchUpWithTerminal(conversation.id);
      if ((this.terminalActivity.get(conversation.id) ?? null) === activity) return;
      if (activity) this.terminalActivity.set(conversation.id, activity);
      else this.terminalActivity.delete(conversation.id);
      this.publish(conversation);
    });
  }

  /**
   * Once the user is done in a terminal, the turns they took there join the conversation, and its agent goes on from
   * them rather than from what it last held. A turn running here goes first; the next look at the terminals catches up.
   */
  private async catchUpWithTerminal(conversationId: string) {
    const runtime = this.runtime(conversationId);
    if (runtime.running || this.stopping || this.catchingUpWithTerminal.has(conversationId)) return;
    this.catchingUpWithTerminal.add(conversationId);
    try {
      await runtime.sessionId?.catch(() => {});
      if (runtime.running) return;
      this.terminalWork.caughtUp(conversationId);
      const { acpSessionId } = this.get(conversationId);
      if (!acpSessionId) return;
      const released = this.releaseSession(runtime, acpSessionId);
      await this.ensureSession(conversationId, async () => {
        await released;
        return this.loadWithTerminalTurns(conversationId, acpSessionId);
      }).catch(() => {});
    } finally {
      this.catchingUpWithTerminal.delete(conversationId);
    }
  }

  /**
   * Conversations pick up a changed or deleted profile from a fresh agent process. Turns in progress stop; with a
   * changed profile they continue where they left off.
   */
  restartProfile(profileId: string) {
    const harness = this.harnessesByProfile.get(profileId);
    this.harnessesByProfile.delete(profileId);
    if (!harness) return;
    void this.killAgent(harness, "was restarted because its profile changed").then((stopped) => {
      if (this.store.findProfile(profileId)) this.continueStoppedTurns(stopped);
    });
  }

  /** Claude Code agents start again with the program now set, as a profile's agent does when the profile changes. */
  restartClaudeAgents() {
    [...this.harnessesByProfile]
      .filter(([profileId]) => this.store.findProfile(profileId)?.harness === "claude")
      .forEach(([profileId, harness]) => {
        this.harnessesByProfile.delete(profileId);
        void this.killAgent(harness, "was restarted because the Claude Code program changed").then((stopped) => this.continueStoppedTurns(stopped));
      });
  }

  /** Stops running turns the way Stop does and holds every queue; returns the conversations whose turn was stopped. */
  async prepareForRestart(): Promise<string[]> {
    this.stopping = true;
    const running = [...this.runtimes].filter(([, runtime]) => runtime.running).map(([conversationId]) => conversationId);
    await Promise.all(running.map((conversationId) => Promise.race([this.stopTurn(conversationId), Bun.sleep(TURN_STOP_TIMEOUT_MS)])));
    return running;
  }

  /**
   * Picks up where the previous host stopped: a turn it stopped for a restart continues where it left off, if the agent
   * recorded it. Otherwise messages still queued (also after a crash) go out, as they would have when the turn ended.
   */
  resumeAfterRestart(stoppedTurns: string[]) {
    this.store.listConversations().forEach(({ id, acpSessionId }) => {
      if (stoppedTurns.includes(id)) this.resumeStoppedTurn(id, acpSessionId).catch(() => {});
      else if (!this.resumeUsageLimitWait(id)) this.sendNextQueuedMessage(id);
    });
    this.jobWaits.startAll();
  }

  shutdown() {
    this.stopping = true;
    this.jobWaits.stopAll();
    return Promise.all([this.commands.shutdown(), ...[...this.harnessesByProfile.values()].map((harness) => harness.stop())]);
  }

  private ensureSession(conversationId: string, open = () => this.openSession(conversationId)): Promise<string> {
    const runtime = this.runtime(conversationId);
    runtime.sessionId ??= open().catch((error) => {
      runtime.sessionId = undefined;
      this.setStatus(conversationId, "error", errorMessage(error));
      throw error;
    });
    return runtime.sessionId;
  }

  private releaseSession(runtime: Runtime, sessionId: string | null) {
    const harness = runtime.harness;
    runtime.harness = undefined;
    runtime.sessionId = undefined;
    if (!harness || !sessionId) return Promise.resolve();
    return Promise.race([harness.closeSession(sessionId).catch(() => {}), Bun.sleep(SESSION_CLOSE_TIMEOUT_MS)]);
  }

  /**
   * Picks up a turn stopped for a restart or a profile switch: the agent continues where it left off if it is still in
   * the session the turn ran in and recorded the request there; otherwise, as in a fresh session, it gets the request again.
   */
  private async resumeStoppedTurn(conversationId: string, stoppedSessionId: string | null) {
    const request = lastTurnRequest(this.store.listEvents(conversationId));
    this.setStatus(conversationId, "starting");
    const sessionId = await this.ensureSession(conversationId);
    if (sessionId === stoppedSessionId && (await this.sessionRecorded(conversationId, sessionId, request))) return this.prompt(conversationId, CONTINUE_AFTER_INTERRUPTION);
    if (request) return this.prompt(conversationId, request.text, { imageIds: request.imageIds });
    this.setStatus(conversationId, "idle");
    this.sendNextQueuedMessage(conversationId);
  }

  /** Only Claude Code's transcript tells whether the agent recorded the message that started a turn. */
  private async sessionRecorded(conversationId: string, sessionId: string, request: TurnRequest | null) {
    const conversation = this.get(conversationId);
    if (conversation.harness !== "claude" || !request) return true;
    return recordsUserMessage(await claudeTranscript(this.claudeConfigDirOf(conversation), sessionId), request.firstText);
  }

  private agentHasRecorded(conversationId: string) {
    return sessionHasRecord(this.store.listEvents(conversationId));
  }

  private async openSession(conversationId: string): Promise<string> {
    const conversation = this.get(conversationId);
    const isFirstSession = conversation.acpSessionId === null;
    const harness = this.harnessFor(conversation);
    this.runtime(conversationId).harness = harness;
    const capabilities = await harness.start();
    const sessionRequest = this.sessionRequest(conversationId, this.existingWorkspace(conversation.workspaceId));

    const canResume = Boolean(capabilities.agentCapabilities?.sessionCapabilities?.resume);
    if (conversation.acpSessionId && canResume && this.agentHasRecorded(conversationId)) {
      try {
        const resumed = await harness.resumeSession({ ...sessionRequest, sessionId: conversation.acpSessionId });
        this.bindSession(conversationId, conversation.acpSessionId, resumed.configOptions);
        await this.restoreConfigChoices(conversationId, conversation.acpSessionId, conversation.configOptions);
        return conversation.acpSessionId;
      } catch (error) {
        this.append(conversationId, {
          type: "error",
          message: `Could not resume the previous agent session (${errorMessage(error)}); starting a fresh one.`,
        });
      }
    }

    const created = await harness.newSession(sessionRequest);
    this.muteNotifier(conversation, created.sessionId);
    this.bindSession(conversationId, created.sessionId, created.configOptions);
    await this.restoreConfigChoices(conversationId, created.sessionId, conversation.configOptions);
    if (isFirstSession) await this.applyProfileMode(conversationId, created.sessionId);
    if (this.onUsersOwnSetup(conversation)) await this.applyTestModelOverride(conversationId, created.sessionId);
    return created.sessionId;
  }

  /** Replayed history arrives as session updates before the load request returns, so the session is bound first. */
  private async loadExternalSession(conversationId: string, sessionId: string, mode: AdoptMode): Promise<string> {
    const conversation = this.get(conversationId);
    const harness = this.harnessFor(conversation);
    this.runtime(conversationId).harness = harness;
    const capabilities = await harness.start();
    if (!capabilities.agentCapabilities?.loadSession) throw new Error(`${harness.spec.label} cannot load existing sessions.`);
    if (mode === "fork" && !capabilities.agentCapabilities.sessionCapabilities?.fork) throw new Error(`${harness.spec.label} cannot fork sessions.`);
    this.setStatus(conversationId, "starting", "Loading the session's history…");
    const sessionRequest = {
      ...this.sessionRequest(conversationId, this.existingWorkspace(conversation.workspaceId)),
      cwd: await recordedDirectory(this.existingWorkspace(conversation.workspaceId)),
    };
    const loadedId = mode === "fork" ? (await harness.forkSession({ sessionId, cwd: sessionRequest.cwd })).sessionId : sessionId;
    this.muteNotifier(conversation, loadedId);
    this.save({ ...this.get(conversationId), acpSessionId: loadedId });
    this.sessions.bind(conversationId, loadedId);
    const loaded = await harness.loadSession({ ...sessionRequest, sessionId: loadedId });
    this.bindSession(conversationId, loadedId, loaded.configOptions);
    if (conversation.harness === "claude") await this.restoreTranscriptModel(conversationId, loadedId, sessionId);
    await this.applyProfileMode(conversationId, loadedId);
    this.setStatus(conversationId, "idle");
    return loadedId;
  }

  private async loadWithTerminalTurns(conversationId: string, sessionId: string): Promise<string> {
    const conversation = this.get(conversationId);
    const harness = this.harnessFor(conversation);
    this.runtime(conversationId).harness = harness;
    const capabilities = await harness.start();
    if (!capabilities.agentCapabilities?.loadSession) throw new Error(`${harness.spec.label} cannot load existing sessions.`);
    this.setStatus(conversationId, "starting", "Reading the turns taken in the terminal…");
    const workspace = this.existingWorkspace(conversation.workspaceId);
    const replay: acp.SessionNotification[] = [];
    this.replaysBeingRead.set(sessionId, replay);
    try {
      const loaded = await harness.loadSession({ ...this.sessionRequest(conversationId, workspace), cwd: await recordedDirectory(workspace), sessionId });
      this.bindSession(conversationId, sessionId, loaded.configOptions);
    } finally {
      this.replaysBeingRead.delete(sessionId);
    }
    const anchor = lastAgentMessageId(this.store.listEvents(conversationId));
    if (anchor) updatesAfter(replay, anchor).forEach((notification) => this.handleSessionUpdate(notification));
    await this.restoreConfigChoices(conversationId, sessionId, conversation.configOptions);
    this.setStatus(conversationId, "idle");
    return sessionId;
  }

  /** A test host's own Claude Code works without the settings and instructions of the user who runs the tests. */
  private sessionRequest(conversationId: string, workspace: Workspace) {
    const conversation = this.get(conversationId);
    const withoutUserSettings = this.config.testSkipsUserSettings && this.onUsersOwnSetup(conversation);
    return { cwd: workspace.path, mcpServers: [this.canvasServerFor(conversationId)], _meta: sessionMeta(conversation.harness, this.store.canvasUse(), { withoutUserSettings }) };
  }

  /** claude-notifier hooks into Claude Code only. */
  private muteNotifier(conversation: Conversation, sessionId: string) {
    if (conversation.harness === "claude") this.notifier.mute(sessionId, conversation.title);
  }

  private existingWorkspace(workspaceId: string) {
    const workspace = this.store.findWorkspace(workspaceId);
    if (!workspace) throw new Error("The workspace no longer exists.");
    return workspace;
  }

  private bindSession(conversationId: string, sessionId: string, configOptions: acp.SessionConfigOption[] | null | undefined) {
    this.sessions.bind(conversationId, sessionId);
    this.save({ ...this.get(conversationId), acpSessionId: sessionId, configOptions: configOptions ?? [] });
    this.updatesForUnknownSessions.take(sessionId).forEach((notification) => this.handleSessionUpdate(notification));
  }

  /** Claude Code resumes a session on the model that answered last, but claude-agent-acp moves it to the model the settings name. */
  private async restoreTranscriptModel(conversationId: string, sessionId: string, recordedSessionId: string) {
    const model = lastAnsweringModel(await claudeTranscript(this.claudeConfigDirOf(this.get(conversationId)), recordedSessionId));
    const choice = model && modelChoiceFor(this.get(conversationId).configOptions, model);
    if (choice) await this.trySetConfigOption(conversationId, sessionId, "model", choice);
  }

  private claudeConfigDirOf({ profileId }: Conversation) {
    return claudeConfigDir(profileEnvironment(profileId === null ? null : (this.store.findProfile(profileId) ?? null)));
  }

  /** A conversation takes its profile's mode when it starts with the profile or moves to it; after that its own choice stands. */
  private async applyProfileMode(conversationId: string, sessionId: string) {
    const { profileId, configOptions } = this.get(conversationId);
    const mode = profileId === null ? null : this.store.findProfile(profileId)?.mode;
    const modeOption = configOptions.find(({ category }) => category === "mode");
    if (mode && modeOption) await this.trySetConfigOption(conversationId, sessionId, modeOption.id, mode);
  }

  /** A resumed or replacement session starts from the agent's defaults, so re-apply what the user had chosen. */
  private async restoreConfigChoices(conversationId: string, sessionId: string, chosen: acp.SessionConfigOption[]) {
    for (const option of chosen) {
      await this.trySetConfigOption(conversationId, sessionId, option.id, option.currentValue);
    }
  }

  private async applyTestModelOverride(conversationId: string, sessionId: string) {
    const { model, effort } = this.config.testModelOverride;
    if (model) await this.trySetConfigOption(conversationId, sessionId, "model", model);
    if (effort) await this.trySetConfigOption(conversationId, sessionId, "effort", effort);
  }

  /**
   * Options depend on each other (haiku has no effort option), so one that no longer exists
   * or is refused must not cost the user their session. Nor may an agent that doesn't answer: Claude Code answers one
   * request at a time, and its first, counting its context's tokens, can wait for a model server to load the model.
   * Such a change still lands once the agent answers, and the session's later changes stop waiting for it meanwhile.
   * A session whose agent process has gone has nothing to change.
   */
  private async trySetConfigOption(conversationId: string, sessionId: string, configId: string, value: ConfigValue) {
    const current = this.get(conversationId).configOptions.find(({ id }) => id === configId);
    const harness = this.runtime(conversationId).harness;
    if (!current || current.currentValue === value || !harness) return;
    const answered = harness.setConfigOption(sessionId, configId, value).then(
      (response) => {
        this.sessionsSlowToAnswer.delete(sessionId);
        if (this.isOnSession(conversationId, sessionId)) this.save({ ...this.get(conversationId), configOptions: response.configOptions });
      },
      (error) => {
        if (this.isOnSession(conversationId, sessionId)) this.append(conversationId, { type: "error", message: `Could not set ${current.name} to ${value}: ${errorMessage(error)}` });
      },
    );
    if (this.sessionsSlowToAnswer.has(sessionId)) return;
    const answeredInTime = await Promise.race([answered.then(() => true), Bun.sleep(OPTION_ANSWER_TIMEOUT_MS).then(() => false)]);
    if (answeredInTime) return;
    this.sessionsSlowToAnswer.add(sessionId);
    this.append(conversationId, {
      type: "error",
      message: `${current.name} is still ${current.currentValue}: the agent has not answered the change to ${value} for ${OPTION_ANSWER_TIMEOUT_MS / 1000} seconds. It changes once the agent answers.`,
    });
  }

  /** The conversation whose agent runs a session, or one of its subagents. */
  async conversationOfSession(sessionId: string): Promise<string | undefined> {
    return this.sessions.conversationOf(sessionId) ?? this.subagentSessions.conversationOf(sessionId);
  }

  private isOnSession(conversationId: string, sessionId: string) {
    return this.store.hasConversation(conversationId) && this.get(conversationId).acpSessionId === sessionId;
  }

  private canvasServerFor(conversationId: string): acp.McpServer {
    return {
      type: "http",
      name: CANVAS_SERVER_NAME,
      url: `${this.config.appOrigin}/mcp/${conversationId}`,
      headers: [{ name: "Authorization", value: `Bearer ${this.config.mcpToken}` }],
    };
  }

  private harnessFor(launch: Launch): HarnessProcess {
    const profile = this.profileOf(launch);
    const existing = this.harnessesByProfile.get(profile.id);
    if (existing) return existing;
    const spec = harnessSpec(profile, this.store.claudeProgramSetting());
    const harness = new HarnessProcess(
      { ...spec, environment: { ...spec.environment, ...this.scriptEnvironment(spec.environment.PATH), ...this.testModelEnvironment(launch) } },
      {
        onSessionUpdate: (notification) => this.handleSessionUpdate(notification),
        onPermissionRequest: (request, signal) => this.handlePermissionRequest(request, signal),
        onExit: (process) => this.handleHarnessExit(process),
      },
      `${this.config.dataDir}/logs`,
    );
    this.harnessesByProfile.set(profile.id, harness);
    return harness;
  }

  /** A test host's Claude Code starts its sessions on the test model, rather than switching to it once a session runs. */
  private testModelEnvironment(launch: Launch): Record<string, string> {
    const { model } = this.config.testModelOverride;
    return this.onUsersOwnSetup(launch) && model ? { ANTHROPIC_MODEL: model } : {};
  }

  /** Claude Code with no profile, or one with no environment of its own: test hosts choose its model and settings, as a profile with an environment does itself. */
  private onUsersOwnSetup({ harness, profileId }: Launch) {
    const profile = profileId === null ? undefined : this.store.findProfile(profileId);
    return harness === "claude" && !profile?.environment.trim();
  }

  /** Where scripts the agent starts reach the host (scripts/mirador-message), and the mirador command they do it with. */
  private scriptEnvironment(path: string | undefined) {
    return { MIRADOR_URL: this.config.appOrigin, MIRADOR_SCRIPT_TOKEN: this.config.scriptToken, ...miradorCommandEnvironment(path) };
  }

  private profileOf({ profileId }: { profileId: string | null }) {
    const profile = profileId === null ? undefined : this.store.findProfile(profileId);
    if (!profile) throw new Error("This conversation has no profile, or its profile was deleted. Pick a profile at the top of the conversation.");
    return profile;
  }

  private handleSessionUpdate(notification: acp.SessionNotification) {
    const replay = this.replaysBeingRead.get(notification.sessionId);
    if (replay) return void replay.push(notification);
    const conversationId = this.sessions.conversationOf(notification.sessionId);
    if (!conversationId) {
      this.updatesForUnknownSessions.remember(notification);
      return;
    }
    const update = notification.update;
    const subagentSession = opencodeSubagentSessionOf(update);
    if (subagentSession) this.subagentSessions.record(subagentSession, conversationId);
    if (update.sessionUpdate === "usage_update") {
      this.contextUsage.set(conversationId, { used: update.used, size: update.size, cost: update.cost ? { amount: update.cost.amount, currency: update.cost.currency } : null });
      const quotas = reportedQuotas(update._meta);
      if (quotas) this.planQuotas.record(this.get(conversationId).profileId, quotas);
      this.publish(this.get(conversationId));
      return;
    }
    if (update.sessionUpdate === "config_option_update") {
      this.save({ ...this.get(conversationId), configOptions: update.configOptions });
    }
    if (update.sessionUpdate === "session_info_update" && update.title && !this.get(conversationId).titleSetByUser) {
      this.save({ ...this.get(conversationId), title: update.title });
    }
    this.append(conversationId, { type: "acp", update });
    this.followToolCalls(conversationId, update);
  }

  private followToolCalls(conversationId: string, update: acp.SessionUpdate) {
    const runtime = this.runtime(conversationId);
    if (!runtime.running) return;
    const activityBefore = this.activity(conversationId);
    const finishedOne = runtime.openToolCalls.follow(update);
    if (!isDeepStrictEqual(this.activity(conversationId), activityBefore)) this.publish(this.get(conversationId));
    if (finishedOne) this.steerQueuedMessages(conversationId);
  }

  private steerQueuedMessages(conversationId: string) {
    const runtime = this.runtime(conversationId);
    runtime.steering = (runtime.steering ?? Promise.resolve()).then(() => this.steerWhileNoToolRuns(conversationId)).catch(() => {});
  }

  /**
   * Messages that join the running turn. Not while a tool call is open: Claude Code would move a running command to the
   * background, and a question or permission prompt the agent waits on with it. Those the agent cannot take go back to
   * the front of the queue, to go out when the turn ends.
   */
  private async steerWhileNoToolRuns(conversationId: string) {
    const runtime = this.runtime(conversationId);
    const { harness } = runtime;
    const sessionId = this.get(conversationId).acpSessionId;
    if (!harness || !sessionId || !runtime.running || runtime.openToolCalls.size > 0 || this.holdsQueue(runtime) || !(await harness.canSteer())) return;
    const messages = queuedBeforeClear(runtime.queuedMessages).filter((message) => !message.afterTurn);
    const [first, ...rest] = messages;
    if (!first) return;
    this.setQueue(conversationId, runtime, runtime.queuedMessages.filter((message) => !messages.includes(message)));
    this.publish(this.get(conversationId));
    const notes = this.notesForAgent(conversationId);
    const text = messages.map((message) => message.text).join("\n\n");
    const imageIds = messages.flatMap((message) => message.imageIds);
    const injected = await this.promptContent(conversationId, withNotes(notes, text), imageIds)
      .then((prompt) => harness.steer(sessionId, prompt))
      .catch(() => false);
    if (!injected) {
      this.setQueue(conversationId, runtime, [...messages, ...runtime.queuedMessages]);
      this.publish(this.get(conversationId));
      if (!runtime.running) this.sendNextQueuedMessage(conversationId);
      return;
    }
    this.appendUserMessage(conversationId, first, notes);
    rest.forEach((message) => this.appendUserMessage(conversationId, message, NO_NOTES));
  }

  /** What the user did since their last message that the agent should hear of with this one. */
  private notesForAgent(conversationId: string): NotesForAgent {
    const events = this.store.listEvents(conversationId);
    return { commands: awaitingDelivery(userCommandsIn(events)), reverts: pendingReverts(events), checklist: this.checklistNoteOf(conversationId) };
  }

  /** The canvas keeps the checklist, and with it what the user ticked that the agent has not heard of. */
  hearChecklistTicksFrom(checklistNoteOf: (conversationId: string) => ChecklistNote | null) {
    this.checklistNoteOf = checklistNoteOf;
  }

  private async promptContent(conversationId: string, text: string, imageIds: string[]): Promise<acp.ContentBlock[]> {
    const images = await Promise.all(imageIds.map((imageId) => this.images.contentBlock(conversationId, imageId)));
    return [{ type: "text", text }, ...images];
  }

  private async handlePermissionRequest(
    request: acp.RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<acp.RequestPermissionResponse> {
    const conversationId = this.sessions.conversationOf(request.sessionId);
    if (!conversationId) return { outcome: { outcome: "cancelled" } };
    const allowOptionId = optionThatAllows(request.options);
    if (allowOptionId && this.get(conversationId).bypassPermissions) {
      return { outcome: { outcome: "selected", optionId: allowOptionId } };
    }
    const runtime = this.runtime(conversationId);
    const editsRead = this.editsAskedFor(conversationId, request.toolCall);
    const inArrivalOrder = (runtime.permissionArriving ?? Promise.resolve()).then(() => editsRead);
    runtime.permissionArriving = inArrivalOrder;
    const edits = await inArrivalOrder;
    if (signal.aborted || !this.store.hasConversation(conversationId)) return { outcome: { outcome: "cancelled" } };
    // YOLO switched on while the files were read approves only the requests already waiting.
    if (allowOptionId && this.get(conversationId).bypassPermissions) return { outcome: { outcome: "selected", optionId: allowOptionId } };
    const permissionId = crypto.randomUUID();
    this.append(conversationId, {
      type: "permission",
      permissionId,
      toolCall: request.toolCall,
      options: request.options,
      ...(edits && { edits }),
    });
    this.notifications.notify(conversationId, { kind: "permission", tool: request.toolCall.title });
    return new Promise((resolve) => {
      const settle: PermissionResolver = (optionId) => {
        if (!runtime.pendingPermissions.delete(permissionId)) return;
        this.append(conversationId, { type: "permission-resolved", permissionId, optionId });
        if (this.store.hasConversation(conversationId)) this.publish(this.get(conversationId));
        resolve(optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } });
      };
      runtime.pendingPermissions.set(permissionId, { settle, allowOptionId, request: pendingPermission(permissionId, request, runtime.openToolCalls.kindOf(request.toolCall.toolCallId)) });
      this.publish(this.get(conversationId));
      signal.addEventListener("abort", () => settle(null), { once: true });
    });
  }

  /** Read before the user answers, since the file changes once they allow the edit. */
  private async editsAskedFor(conversationId: string, toolCall: acp.ToolCallUpdate) {
    try {
      const workspace = this.existingWorkspace(this.get(conversationId).workspaceId);
      return await editDiffsOf(toolCall, [await recordedDirectory(workspace), workspace.path]);
    } catch {
      return undefined;
    }
  }

  private handleHarnessExit(harness: HarnessProcess) {
    this.harnessesByProfile.forEach((current, key) => {
      if (current === harness) this.harnessesByProfile.delete(key);
    });
    this.runtimes.forEach((runtime, conversationId) => {
      if (runtime.harness !== harness) return;
      runtime.harness = undefined;
      runtime.sessionId = undefined;
      runtime.pendingPermissions.forEach(({ settle }) => settle(null));
    });
  }

  /** A turn the host was killed in the middle of has no end in the log, which leaves its subagent cards working for good. */
  private endTurnsOrphanedByRestart() {
    this.store.takeTurnsInFlight().forEach((id) => {
      if (openTurnTheAgentWorkedOn(this.store.listEvents(id))) this.store.appendEvent(id, { type: "turn-end", stopReason: "cancelled" });
    });
  }

  private cancelPermissionsOrphanedByRestart() {
    this.store.listConversations().forEach((conversation) => {
      const events = this.store.listEvents(conversation.id);
      const resolved = new Set(
        events.flatMap(({ event }) => (event.type === "permission-resolved" ? [event.permissionId] : [])),
      );
      events
        .flatMap(({ event }) => (event.type === "permission" && !resolved.has(event.permissionId) ? [event.permissionId] : []))
        .forEach((permissionId) =>
          this.store.appendEvent(conversation.id, { type: "permission-resolved", permissionId, optionId: null }),
        );
    });
  }

  /** The queue is kept in the database too, so messages waiting for the agent survive a host restart or crash. */
  private setQueue(conversationId: string, runtime: Runtime, queue: QueuedMessage[]) {
    runtime.queuedMessages = queue;
    this.store.saveQueuedMessages(conversationId, queue);
  }

  private holdsQueue(runtime: Runtime) {
    return runtime.holdingQueue || this.stopping || runtime.usageLimit !== undefined;
  }

  /** Returns the failure's message. A turn Claude's usage limit stopped holds the queue until the limit resets. */
  private recordTurnFailure(conversationId: string, error: unknown, promptSent: boolean) {
    const continuable = promptSent && { continuable: true as const };
    if (!isUsageLimitError(error) || !this.store.hasConversation(conversationId)) {
      this.append(conversationId, { type: "error", message: errorMessage(error), ...continuable, ...(isAuthRequiredError(error) && { authRequired: true as const }) });
      return errorMessage(error);
    }
    const message = usageLimitMessage(error);
    const resetsAt = usageLimitResetIn(message);
    this.append(conversationId, { type: "error", message, usageLimit: { resetsAt }, ...continuable });
    this.waitForUsageLimitReset(conversationId, resetsAt);
    return message;
  }

  private waitForUsageLimitReset(conversationId: string, resetsAt: number | null) {
    const runtime = this.runtime(conversationId);
    const continuesAt = this.automaticContinueAt(runtime, resetsAt);
    const timer =
      continuesAt === null
        ? undefined
        : setTimeout(() => this.continueAfterUsageLimit(conversationId, { automatically: true }), Math.max(0, continuesAt - Date.now()));
    runtime.usageLimit = { wait: { resetsAt, continuesAt }, timer };
  }

  /** A reset further off than a timer can wait is surely misread, so then the user continues by hand. */
  private automaticContinueAt(runtime: Runtime, resetsAt: number | null) {
    if (resetsAt === null || runtime.automaticContinues >= AUTOMATIC_CONTINUES_IN_A_ROW) return null;
    const continuesAt = resetsAt + USAGE_LIMIT_RESET_MARGIN_MS;
    return continuesAt - Date.now() <= LONGEST_TIMER_MS ? continuesAt : null;
  }

  /** Returns whether it was waiting. */
  private endUsageLimitWait(runtime: Runtime) {
    if (!runtime.usageLimit) return false;
    clearTimeout(runtime.usageLimit.timer);
    runtime.usageLimit = undefined;
    return true;
  }

  /** A conversation the previous host left waiting for a usage limit's reset waits for it again. */
  private resumeUsageLimitWait(conversationId: string) {
    const latest = this.store.latestTurnEvent(conversationId);
    if (latest?.type !== "error" || !latest.usageLimit) return false;
    this.waitForUsageLimitReset(conversationId, latest.usageLimit.resetsAt);
    this.publish(this.get(conversationId));
    return true;
  }

  private replaceQueue(conversationId: string, change: (queue: QueuedMessage[]) => QueuedMessage[], messageId: string) {
    const runtime = this.runtime(conversationId);
    if (!runtime.queuedMessages.some(({ id }) => id === messageId)) throw new Error("That message was already sent.");
    this.setQueue(conversationId, runtime, change(runtime.queuedMessages));
    this.publish(this.get(conversationId));
  }

  /** A turn that started meanwhile, e.g. while a /clear opened the fresh session, sends the queue on once it ends. */
  private sendNextQueuedMessage(conversationId: string) {
    const runtime = this.store.hasConversation(conversationId) ? this.runtime(conversationId) : undefined;
    const [next, ...rest] = runtime?.queuedMessages ?? [];
    if (!runtime || !next || runtime.running || this.holdsQueue(runtime)) return;
    this.setQueue(conversationId, runtime, rest);
    this.prompt(conversationId, next.text, { imageIds: next.imageIds, fromScript: next.fromScript, startsTurn: true }).catch(() => {});
  }

  private appendUserMessage(
    conversationId: string,
    { text, imageIds, fromScript, checkpoint }: Omit<QueuedMessage, "id"> & { checkpoint?: string | null },
    { commands, reverts, checklist }: NotesForAgent,
  ) {
    checklist?.heard();
    const attachedCommandIds = commands.map(({ commandId }) => commandId);
    const attachedRevertIds = reverts.map(({ revertId }) => revertId);
    this.append(conversationId, {
      type: "user-message",
      text,
      ...(attachedCommandIds.length > 0 && { attachedCommandIds }),
      ...(attachedRevertIds.length > 0 && { attachedRevertIds }),
      ...(imageIds.length > 0 && { imageIds }),
      ...(fromScript && { fromScript }),
      ...(checkpoint && { checkpoint }),
    });
  }

  private retitleFromFirstMessage(conversationId: string, text: string) {
    const conversation = this.get(conversationId);
    if (conversation.title !== UNTITLED || conversation.titleSetByUser) return;
    const firstLine = text.trim().split("\n")[0] ?? "";
    const title = cutWithEllipsis(firstLine, TITLE_LENGTH - 1, TITLE_LENGTH);
    if (title) this.save({ ...conversation, title });
  }

  private runtime(conversationId: string): Runtime {
    let runtime = this.runtimes.get(conversationId);
    if (!runtime) {
      const queuedMessages = this.store.findConversation(conversationId)?.queuedMessages ?? [];
      runtime = { running: false, holdingQueue: false, pendingPermissions: new Map(), queuedMessages, openToolCalls: new OpenToolCalls(), automaticContinues: 0 };
      this.runtimes.set(conversationId, runtime);
    }
    return runtime;
  }

  /** A turn that was still running when its conversation got deleted ends without a trace. */
  private append(conversationId: string, event: ConversationEvent) {
    if (!this.store.hasConversation(conversationId)) return;
    const stored = this.store.appendEvent(conversationId, event);
    this.hub.publishEvent(conversationId, stored);
  }

  private notifyTurnEnded(conversationId: string, outcome: TurnOutcome) {
    if (!this.store.hasConversation(conversationId)) return;
    const reason = turnEndReason(outcome, this.runtime(conversationId).queuedMessages.length > 0);
    if (!reason || this.stopping) return;
    this.notifications.notify(conversationId, reason);
    if (this.hub.isWatched(conversationId)) return;
    this.unseenTurnEnds.set(conversationId, reason.kind);
    this.store.setUnseenTurnEnd(conversationId, reason.kind);
    this.keepLastWords(conversationId);
  }

  private forgetUnseenTurnEnd(conversationId: string) {
    if (!this.unseenTurnEnds.delete(conversationId)) return false;
    this.lastWords.delete(conversationId);
    this.store.setUnseenTurnEnd(conversationId, null);
    return true;
  }

  /** Worked out once when a turn ends unseen, since publishing, which happens all the time, must not read the events. */
  private keepLastWords(conversationId: string) {
    const turnStart = this.store.latestTurnStart(conversationId)?.seq ?? 0;
    const words = lastWordsOf(this.store.listEventsFrom(conversationId, turnStart));
    if (words) this.lastWords.set(conversationId, words);
    else this.lastWords.delete(conversationId);
  }

  private activity(conversationId: string): Activity | null {
    const runtime = this.runtimes.get(conversationId);
    if (!runtime?.running) return null;
    return currentActivity(runtime.openToolCalls, [...runtime.pendingPermissions.values()].map(({ request }) => request.title));
  }

  /** Every conversation `waitingFor` could find waiting, from the three things it reads, so counting reads no database. */
  private conversationsThatMayWait() {
    return new Set([...this.runtimes.keys(), ...this.asksWaitedOn.keys(), ...this.unseenTurnEnds.keys()]);
  }

  private waitingFor(conversationId: string): WaitingFor | null {
    if ((this.runtimes.get(conversationId)?.pendingPermissions.size ?? 0) > 0) return "permission";
    if (this.asksWaitedOn.has(conversationId)) return "question";
    return this.unseenTurnEnds.get(conversationId) ?? null;
  }

  private pendingRequest(conversationId: string): PendingRequest | null {
    const [oldestPermission] = this.runtimes.get(conversationId)?.pendingPermissions.values() ?? [];
    return oldestPermission?.request ?? this.asksWaitedOn.get(conversationId) ?? null;
  }

  private setStatus(conversationId: string, status: ConversationStatus, statusDetail: string | null = null) {
    if (!this.store.hasConversation(conversationId)) return;
    this.statusOverrides.set(conversationId, { status, statusDetail });
    this.publish(this.get(conversationId));
  }

  private withRuntimeStatus(conversation: Conversation): Conversation {
    return {
      ...conversation,
      ...this.statusOverrides.get(conversation.id),
      openInTerminal: this.terminalActivity.get(conversation.id) ?? null,
      contextUsage: this.contextUsage.get(conversation.id) ?? null,
      queuedMessages: this.runtimes.get(conversation.id)?.queuedMessages ?? conversation.queuedMessages,
      usageLimit: this.runtimes.get(conversation.id)?.usageLimit?.wait ?? null,
      jobWaits: this.jobWaits.in(conversation.id),
      waitingFor: this.waitingFor(conversation.id),
      pendingRequest: this.pendingRequest(conversation.id),
      lastWords: this.lastWords.get(conversation.id) ?? null,
      activity: this.activity(conversation.id),
    };
  }

  private save(conversation: Conversation) {
    const updated = { ...conversation, updatedAt: Date.now() };
    this.store.updateConversation(updated);
    this.publish(updated);
  }

  private republish(conversationId: string) {
    if (this.store.hasConversation(conversationId)) this.publish(this.get(conversationId));
  }

  private publish(conversation: Conversation) {
    this.hub.broadcast({ type: "conversation.upserted", conversation: this.withRuntimeStatus(conversation) });
    this.announceWaitingCount();
  }

  private announceWaitingCount() {
    this.hub.announceWaitingCount(this.waitingCount());
  }

  private announceRunningTurnsCount() {
    this.hub.announceRunningTurnsCount(this.runningTurnsCount());
  }
}


/**
 * Claude Code keeps no record of a session until the agent works on a message in it, so a session without a finished
 * turn, agent output or replayed history cannot be resumed. Since a /clear, only what came after it counts.
 */
export function sessionHasRecord(events: StoredEvent[]) {
  const sinceCleared = events.slice(events.findLastIndex(({ event }) => event.type === "context-cleared") + 1);
  return sinceCleared.some(({ event }) => event.type === "turn-end" || (event.type === "acp" && updatesTheAgentRecords.has(event.update.sessionUpdate)));
}

interface TurnRequest {
  /** The message that started the turn and those that joined it, as one. */
  text: string;
  firstText: string;
  imageIds: string[];
}

const endsTurn = ({ event }: Pick<StoredEvent, "event">) => event.type === "turn-end" || event.type === "error";

/** opencode 2 marks what a subagent does, reported through its conversation's session, with the subagent's own session. */
export function opencodeSubagentSessionOf(update: acp.SessionUpdate): string | null {
  const { id } = (update._meta?.["opencode/child-session"] ?? {}) as { id?: unknown };
  return typeof id === "string" ? id : null;
}

/**
 * A turn left open: it began, the agent worked on it, and nothing ended it. A turn the agent never worked on is not one,
 * since an end written for it would claim a session that can be resumed.
 */
export function openTurnTheAgentWorkedOn(events: StoredEvent[]): boolean {
  const began = events.findLastIndex(({ event }) => event.type === "user-message" || endsTurn({ event }));
  if (events[began]?.event.type !== "user-message") return false;
  return events.slice(began + 1).some(({ event }) => event.type === "acp" && updatesTheAgentRecords.has(event.update.sessionUpdate));
}

/** What the user asked in the turn that ended last: the message that started it and any that joined it. */
export function lastTurnRequest(events: StoredEvent[]): TurnRequest | null {
  const lastEnd = events.findLastIndex(endsTurn);
  const start = events.slice(0, Math.max(lastEnd, 0)).findLastIndex(endsTurn) + 1;
  const messages = events.slice(start, lastEnd === -1 ? undefined : lastEnd).flatMap(({ event }) => (event.type === "user-message" ? [event] : []));
  const [first] = messages;
  if (!first) return null;
  return { text: messages.map(({ text }) => text).join("\n\n"), firstText: first.text, imageIds: messages.flatMap(({ imageIds = [] }) => imageIds) };
}

/** Messages queued after a /clear wait for it, rather than join the turn in the session it ends. */
export const queuedBeforeClear = (queue: QueuedMessage[]) => {
  const clearAt = queue.findIndex(({ text }) => isClearCommand(text));
  return clearAt === -1 ? queue : queue.slice(0, clearAt);
};

/** Allowing once leaves no trace behind; Claude Code saves an "always" answer into the project's settings. */
export function optionThatAllows(options: acp.PermissionOption[]): string | null {
  const allowing = options.find(({ kind }) => kind === "allow_once") ?? options.find(({ kind }) => kind === "allow_always");
  return allowing?.optionId ?? null;
}

/** Claude Code and opencode record a session's directory with symlinks resolved (e.g. /var → /private/var on macOS). */
const recordedDirectory = (workspace: Workspace) => realpath(workspace.path);

export function errorMessage(error: unknown): string {
  if (typeof error !== "object" || error === null) return String(error);
  const { message, data } = error as { message?: unknown; data?: unknown };
  const details = detailsWorthShowing(data);
  return details === null ? String(message ?? error) : `${String(message ?? error)}: ${details}`;
}

/**
 * Tags for the host to read, not for people: Claude Code tags an error with its kind, e.g. {"errorKind":"server_error"},
 * and opencode with where it failed, e.g. {"service":"session","errorName":"provider.invalid-request"}.
 */
const ERROR_TAGS = new Set(["errorKind", "service", "errorName"]);

/** opencode hands an error whose message isn't JSON over as {"details": message}, which reads best as the message alone. */
function detailsWorthShowing(data: unknown) {
  if (data === undefined || data === null) return null;
  if (typeof data !== "object") return String(data);
  if (Array.isArray(data)) return JSON.stringify(data);
  const details = Object.fromEntries(Object.entries(data).filter(([key]) => !ERROR_TAGS.has(key)));
  const keys = Object.keys(details);
  if (keys.length === 0) return null;
  return keys.length === 1 && typeof details.details === "string" ? details.details : JSON.stringify(details);
}
