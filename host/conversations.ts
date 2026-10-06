import { realpath } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import type * as acp from "@agentclientprotocol/sdk";
import {
  harnessLabels,
  type Activity,
  type AdoptMode,
  type AskMode,
  type ContextUsage,
  type Conversation,
  type ConversationEvent,
  type ConversationStatus,
  type ExternalSession,
  type JobWait,
  type JobWaitEnd,
  type Launch,
  type QueuedMessage,
  type RestorePlan,
  type StoredEvent,
  type TerminalActivity,
  type UsageLimitWait,
  type WaitingFor,
  type Workspace,
} from "../shared/model.ts";
import { messageAtEnd, type JobWaitRequest } from "../shared/job-waits.ts";
import { historyEntry } from "../shared/prompt-history.ts";
import { inSidebarOrder, movedBefore } from "../shared/sidebar-order.ts";
import { isClearCommand, toSlashCommand } from "../shared/slash-commands.ts";
import { currentActivity, OpenToolCalls } from "./activity.ts";
import { mentionSuggestions } from "./mentions.ts";
import { PlanQuotasByProfile, reportedQuotas } from "./plan-quotas.ts";
import { turnEndReason, type TurnOutcome } from "../shared/system-notifications.ts";
import { isUsageLimitError, usageLimitMessage, usageLimitResetIn } from "../shared/usage-limit.ts";
import { awaitingDelivery, userCommandsIn, withCommandOutputs, type UserCommand } from "../shared/user-commands.ts";
import { pendingReverts, withRevertNotes, type Revert } from "../shared/reverts.ts";
import { miradorCommandEnvironment } from "./acp/environment.ts";
import { CANVAS_SERVER_NAME, harnessSpec, isAuthRequiredError, launchEnvironment, loginCommand, profileEnvironment, sessionMeta } from "./acp/harnesses.ts";
import { HarnessProcess, type ConfigValue } from "./acp/harness.ts";
import type { HostConfig } from "./config.ts";
import type { Hub } from "./hub.ts";
import type { ImageStore } from "./images.ts";
import { followJobProgram, JobWaits } from "./job-waits.ts";
import type { NotifierMute } from "./notifier.ts";
import { Checkpoints } from "./checkpoints.ts";
import { assertLaunchable } from "./profiles.ts";
import type { Store, UnseenTurnEnd } from "./store.ts";
import type { SystemNotifications } from "./system-notifications.ts";
import type { TerminalProgram } from "./terminals.ts";
import { claudeConfigDir } from "./terminal-sessions.ts";
import { claudeTranscript, lastAnsweringModel, modelChoiceFor, recordsUserMessage } from "./claude-transcript.ts";
import { UserCommandRunner } from "./user-commands.ts";

const UNTITLED = "New conversation";
const MAX_TITLE_LENGTH = 200;
const LISTED_SESSIONS = 30;
const TITLE_LENGTH = 60;
const CONTINUE_AFTER_INTERRUPTION = "Continue where you left off.";
const NO_FILES_KEPT = "Mirador kept no files for that turn, so there is nothing to undo it to.";
const ONLY_GIT_REPOSITORIES = "Mirador keeps a turn's files only in a workspace that is a git repository.";
const TURN_STOP_TIMEOUT_MS = 10_000;
/** Like Claude Code: the agent continues a minute after its usage limit resets, at most twice in a row by itself. */
const USAGE_LIMIT_RESET_MARGIN_MS = 60_000;
const AUTOMATIC_CONTINUES_IN_A_ROW = 2;

type PermissionResolver = (optionId: string | null) => void;

interface PendingPermission {
  settle: PermissionResolver;
  allowOptionId: string | null;
  tool: string;
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
  queuedMessages: QueuedMessage[];
  openToolCalls: OpenToolCalls;
  usageLimit?: { wait: UsageLimitWait; timer?: ReturnType<typeof setTimeout> };
  /** How often in a row the agent continued by itself after a usage limit's reset, without a turn that succeeded. */
  automaticContinues: number;
  /** The agent process this turn runs on is being killed by the user, so the turn ends as a stop, not as a failure. */
  forceStopped?: boolean;
}

export class ConversationService {
  private readonly runtimes = new Map<string, Runtime>();
  /** One agent process per profile, and one per agent for conversations without a profile. */
  private readonly harnessesByLaunch = new Map<string, HarnessProcess>();
  private readonly conversationBySession = new Map<string, string>();
  private readonly updatesForUnknownSessions = new Map<string, acp.SessionNotification[]>();
  private readonly statusOverrides = new Map<string, Pick<Conversation, "status" | "statusDetail">>();
  private readonly terminalActivity = new Map<string, TerminalActivity>();
  private readonly contextUsage = new Map<string, ContextUsage>();
  private readonly planQuotas = new PlanQuotasByProfile();
  private readonly unseenTurnEnds: Map<string, UnseenTurnEnd>;
  private readonly conversationsWithQuestions: Set<string>;
  private readonly commands = new UserCommandRunner();
  private readonly jobWaits: JobWaits;
  private readonly checkpoints: Checkpoints;
  /** While the host stops or restarts, messages wait in the queue for the next host, and turns it ends are not the agent's failures. */
  private stopping = false;

  constructor(
    private readonly store: Store,
    private readonly hub: Hub,
    private readonly config: HostConfig,
    private readonly notifier: NotifierMute,
    private readonly images: ImageStore,
    private readonly notifications: SystemNotifications,
  ) {
    this.checkpoints = new Checkpoints(config.dataDir);
    this.cancelPermissionsOrphanedByRestart();
    this.unseenTurnEnds = new Map(store.listUnseenTurnEnds());
    this.conversationsWithQuestions = new Set(store.listCanvasItemsWithStatus("waiting").map(({ conversationId }) => conversationId));
    this.jobWaits = new JobWaits(store, {
      changed: (conversationId) => this.republish(conversationId),
      ended: (conversationId, wait, end) => this.jobWaitEnded(conversationId, wait, end),
    });
  }

  list(): Conversation[] {
    return this.store.listConversations().map((conversation) => this.withRuntimeStatus(conversation));
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

  create(workspaceId: string, launch: Launch): Conversation {
    const conversation = this.insertConversation(workspaceId, launch, UNTITLED);
    this.ensureSession(conversation.id).catch(() => {});
    return conversation;
  }

  /** The newest sessions the harness knows for the workspace directory, including ones started outside the app. */
  async listSessionsInWorkspace(workspaceId: string, launch: Launch): Promise<ExternalSession[]> {
    const directory = await recordedDirectory(this.existingWorkspace(workspaceId));
    assertLaunchable(this.store, launch);
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
    assertLaunchable(this.store, launch);
    const profile = launch.profileId === null ? undefined : this.existingProfile(launch.profileId);
    const now = Date.now();
    const conversation = this.store.insertConversation({
      id: crypto.randomUUID(),
      workspaceId,
      harness: launch.harness,
      profileId: launch.profileId,
      title,
      titleSetByUser: false,
      acpSessionId: null,
      askMode: profile?.askMode ?? "wait",
      bypassPermissions: profile?.bypassPermissions ?? false,
      status: "idle",
      statusDetail: null,
      openInTerminal: null,
      contextUsage: null,
      queuedMessages: [],
      usageLimit: null,
      jobWaits: [],
      waitingFor: null,
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
      this.conversationBySession.delete(conversation.acpSessionId);
    }
    const runtime = this.runtimes.get(conversationId);
    if (runtime) this.endUsageLimitWait(runtime);
    this.jobWaits.forget(conversationId);
    this.runtimes.delete(conversationId);
    this.statusOverrides.delete(conversationId);
    this.terminalActivity.delete(conversationId);
    this.contextUsage.delete(conversationId);
    this.unseenTurnEnds.delete(conversationId);
    this.conversationsWithQuestions.delete(conversationId);
    this.store.deleteConversation(conversationId);
    this.images.deleteConversation(conversationId);
    this.hub.broadcast({ type: "conversation.deleted", conversationId });
  }

  deleteAllInWorkspace(workspaceId: string) {
    this.store
      .listConversations()
      .filter((conversation) => conversation.workspaceId === workspaceId)
      .forEach((conversation) => this.delete(conversation.id));
  }

  rename(conversationId: string, title: string) {
    const name = title.trim().slice(0, MAX_TITLE_LENGTH);
    if (!name) throw new Error("A conversation needs a name.");
    this.save({ ...this.get(conversationId), title: name, titleSetByUser: true });
  }

  /**
   * Moves the conversation to another profile of the same agent. The old agent process lets go of
   * the session first, then the new one resumes it, with the new profile's model rather than the old choice.
   */
  /**
   * Moves the conversation's session to the agent process of another profile of its agent. A turn in progress
   * is stopped first and, once the session is back, continued under the new profile; queued messages follow.
   */
  setProfile(conversationId: string, profileId: string | null) {
    const runtime = this.runtime(conversationId);
    const switched = (runtime.profileSwitch ?? Promise.resolve()).then(() => this.switchProfile(conversationId, profileId));
    runtime.profileSwitch = switched.catch(() => {});
    return switched;
  }

  private async switchProfile(conversationId: string, profileId: string | null) {
    const runtime = this.runtime(conversationId);
    await runtime.sessionId?.catch(() => {});
    if (this.get(conversationId).profileId === profileId) return;
    assertLaunchable(this.store, { harness: this.get(conversationId).harness, profileId });
    const interrupted = runtime.running;
    runtime.holdingQueue = interrupted;
    if (interrupted) await this.stopTurn(conversationId);
    const conversation = this.get(conversationId);
    const released = this.releaseSession(runtime, conversation.acpSessionId);
    const profile = profileId === null ? undefined : this.existingProfile(profileId);
    this.save({
      ...conversation,
      profileId,
      ...(profile && { askMode: profile.askMode, bypassPermissions: profile.bypassPermissions }),
      acpSessionId: this.agentHasRecorded(conversationId) ? conversation.acpSessionId : null,
      configOptions: conversation.configOptions.filter(({ id }) => id !== "model"),
    });
    this.append(conversationId, { type: "profile-changed", profileName: profileId && this.existingProfile(profileId).name });
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

  private async stopTurn(conversationId: string) {
    const { turnEnded } = this.runtime(conversationId);
    await this.cancel(conversationId);
    await turnEnded;
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
    this.endUsageLimitWait(runtime);
    let endTurn = () => {};
    runtime.turnEnded = new Promise((resolve) => (endTurn = resolve));
    runtime.openToolCalls.clear();
    this.forgetUnseenTurnEnd(conversationId);
    this.retitleFromFirstMessage(conversationId, text);
    const events = this.store.listEvents(conversationId);
    const commands = awaitingDelivery(userCommandsIn(events));
    const reverts = pendingReverts(events);
    this.setStatus(conversationId, "starting");
    const checkpoint = startsTurn ? await this.snapshotFiles(conversationId) : null;
    this.appendUserMessage(conversationId, { text, imageIds, ...(fromScript && { fromScript }), ...(checkpoint && { checkpoint }) }, { commands, reverts });
    try {
      const sessionId = await this.ensureSession(conversationId);
      this.setStatus(conversationId, "running");
      const prompt = await this.promptContent(conversationId, withCommandOutputs(commands, withRevertNotes(reverts, text)), imageIds);
      const response = await this.harnessFor(this.get(conversationId)).prompt(sessionId, prompt);
      this.append(conversationId, { type: "turn-end", stopReason: response.stopReason });
      runtime.automaticContinues = 0;
      this.notifyTurnEnded(conversationId, { stopReason: response.stopReason });
    } catch (error) {
      if (runtime.forceStopped) {
        this.append(conversationId, { type: "turn-end", stopReason: "cancelled" });
        this.notifyTurnEnded(conversationId, { stopReason: "cancelled" });
      } else {
        this.notifyTurnEnded(conversationId, { error: this.recordTurnFailure(conversationId, error) });
      }
    } finally {
      runtime.running = false;
      runtime.forceStopped = false;
      this.setStatus(conversationId, "idle");
      endTurn();
    }
    this.sendNextQueuedMessage(conversationId);
  }

  /**
   * Sends `text` as the next user message. While a turn is running it waits in the queue: like in Claude Code it joins
   * the turn once the tools the agent is waiting on have finished, or, sent `afterTurn`, it goes out when the turn ends.
   */
  async send(conversationId: string, text: string, imageIds: string[] = [], { fromScript = false, afterTurn = false } = {}) {
    const runtime = this.runtime(conversationId);
    if (!runtime.running && !this.stopping && !runtime.usageLimit) return this.prompt(conversationId, text, { imageIds, fromScript, startsTurn: true });
    const message: QueuedMessage = { id: crypto.randomUUID(), text, imageIds, ...(fromScript && { fromScript }), ...(afterTurn && { afterTurn }) };
    this.setQueue(conversationId, runtime, [...runtime.queuedMessages, message]);
    this.publish(this.get(conversationId));
  }

  /** What undoing the turn that began with this message would do to the files, or why it cannot be undone. */
  async previewRevert(conversationId: string, seq: number): Promise<{ plan: RestorePlan | null; cannotUndo?: string }> {
    const checkpoint = this.checkpointAt(conversationId, seq);
    if (!checkpoint) return { plan: null, cannotUndo: NO_FILES_KEPT };
    const plan = await this.checkpoints.preview(this.workspaceOf(conversationId), checkpoint);
    return plan ? { plan } : { plan: null, cannotUndo: ONLY_GIT_REPOSITORIES };
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
    const plan = await this.checkpoints.restore(this.workspaceOf(conversationId), checkpoint);
    this.append(conversationId, { type: "revert", revertId: crypto.randomUUID(), toSeq: seq, restored: plan.restored, removed: plan.removed });
    return plan;
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
  jobFollowProgram(conversationId: string, waitId: string): { workspaceId: string; program: TerminalProgram } {
    const wait = this.jobWaits.in(conversationId).find(({ id }) => id === waitId);
    if (!wait) throw new Error("Mirador no longer waits for that job.");
    return { workspaceId: this.get(conversationId).workspaceId, program: followJobProgram(wait) };
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
    const waiting = this.store.listCanvasItems(conversationId).some(({ status }) => status === "waiting");
    if (waiting) this.conversationsWithQuestions.add(conversationId);
    else this.conversationsWithQuestions.delete(conversationId);
    if (this.store.hasConversation(conversationId)) this.publish(this.get(conversationId));
  }

  /** Runs a `!` command from the message box in the conversation's workspace, with the environment its agent gets. */
  runCommand(conversationId: string, command: string) {
    const conversation = this.get(conversationId);
    const directory = this.store.findWorkspace(conversation.workspaceId)?.path;
    if (!directory) throw new Error("This conversation's workspace no longer exists.");
    const environment = profileEnvironment(conversation.profileId === null ? null : this.existingProfile(conversation.profileId));
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
  }

  /** The agent's own sign-in, with the environment of the conversation's profile, so a profile with its own account signs that one in. */
  loginProgram(conversationId: string): { workspaceId: string; program: TerminalProgram } {
    const conversation = this.get(conversationId);
    const profile = conversation.profileId === null ? null : this.existingProfile(conversation.profileId);
    const environment = launchEnvironment(conversation.harness, profile, this.store.claudeProgramSetting());
    return {
      workspaceId: conversation.workspaceId,
      program: { tabName: `${harnessLabels[conversation.harness]} sign-in`, command: loginCommand(conversation.harness, environment), environment },
    };
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
   * Siblings on the same process lose their turn too, so once they have ended, they continue where they left off, as
   * after a restart; the conversation the user force-stopped stays stopped. Every turn the kill ends is the user's
   * doing rather than the agent's failure, so each ends the way a stop ends it.
   */
  private async forceCancel(conversationId: string): Promise<void> {
    const runtime = this.runtime(conversationId);
    const harness = runtime.harness;
    if (!harness) return this.cancel(conversationId);
    const interrupted = [...this.runtimes]
      .filter(([id, other]) => id !== conversationId && other.harness === harness && other.running)
      .map(([id, other]) => ({ id, other, stoppedSessionId: this.get(id).acpSessionId }));
    [runtime, ...interrupted.map(({ other }) => other)].forEach((stopped) => (stopped.forceStopped = true));
    await harness.stop("was force stopped");
    await Promise.all([runtime.turnEnded, ...interrupted.map(({ other }) => other.turnEnded)]);
    interrupted.forEach(({ id, stoppedSessionId }) => this.resumeStoppedTurn(id, stoppedSessionId).catch(() => {}));
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
      if ((this.terminalActivity.get(conversation.id) ?? null) === activity) return;
      if (activity) this.terminalActivity.set(conversation.id, activity);
      else this.terminalActivity.delete(conversation.id);
      this.publish(conversation);
    });
  }

  /** Conversations pick up a changed or deleted profile from a fresh agent process; turns in progress stop. */
  restartProfile(profileId: string) {
    const harness = this.harnessesByLaunch.get(profileId);
    this.harnessesByLaunch.delete(profileId);
    harness?.stop("was restarted because its profile changed");
  }

  /** Claude Code agents start again with the program now set, as a profile's agent does when the profile changes. */
  restartClaudeAgents() {
    [...this.harnessesByLaunch]
      .filter(([key]) => key === "claude" || this.store.findProfile(key)?.harness === "claude")
      .forEach(([key, harness]) => {
        this.harnessesByLaunch.delete(key);
        harness.stop("was restarted because the Claude Code program changed");
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
    return Promise.all([this.commands.shutdown(), ...[...this.harnessesByLaunch.values()].map((harness) => harness.stop())]);
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
    return harness && sessionId ? harness.closeSession(sessionId).catch(() => {}) : Promise.resolve();
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
    if (conversation.harness === "claude" && conversation.profileId === null) {
      await this.applyTestModelOverride(conversationId, created.sessionId);
    }
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
    this.conversationBySession.set(loadedId, conversationId);
    const loaded = await harness.loadSession({ ...sessionRequest, sessionId: loadedId });
    this.bindSession(conversationId, loadedId, loaded.configOptions);
    if (conversation.harness === "claude") await this.restoreTranscriptModel(conversationId, loadedId, sessionId);
    await this.applyProfileMode(conversationId, loadedId);
    this.setStatus(conversationId, "idle");
    return loadedId;
  }

  /** A test host's own Claude Code works without the settings and instructions of the user who runs the tests. */
  private sessionRequest(conversationId: string, workspace: Workspace) {
    const { harness, profileId } = this.get(conversationId);
    const withoutUserSettings = this.config.testSkipsUserSettings && profileId === null;
    return { cwd: workspace.path, mcpServers: [this.canvasServerFor(conversationId)], _meta: sessionMeta(harness, this.store.canvasUse(), { withoutUserSettings }) };
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
    this.conversationBySession.set(sessionId, conversationId);
    this.save({ ...this.get(conversationId), acpSessionId: sessionId, configOptions: configOptions ?? [] });
    const early = this.updatesForUnknownSessions.get(sessionId) ?? [];
    this.updatesForUnknownSessions.delete(sessionId);
    early.forEach((notification) => this.handleSessionUpdate(notification));
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
   * or is refused must not cost the user their session.
   */
  private async trySetConfigOption(conversationId: string, sessionId: string, configId: string, value: ConfigValue) {
    const current = this.get(conversationId).configOptions.find(({ id }) => id === configId);
    if (!current || current.currentValue === value) return;
    try {
      const response = await this.harnessFor(this.get(conversationId)).setConfigOption(sessionId, configId, value);
      this.save({ ...this.get(conversationId), configOptions: response.configOptions });
    } catch (error) {
      this.append(conversationId, { type: "error", message: `Could not set ${current.name} to ${value}: ${errorMessage(error)}` });
    }
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
    const key = launch.profileId ?? launch.harness;
    const existing = this.harnessesByLaunch.get(key);
    if (existing) return existing;
    const spec = harnessSpec(launch.harness, launch.profileId === null ? null : this.existingProfile(launch.profileId), this.store.claudeProgramSetting());
    const harness = new HarnessProcess(
      { ...spec, environment: { ...spec.environment, ...this.scriptEnvironment(spec.environment.PATH), ...this.testModelEnvironment(launch) } },
      {
        onSessionUpdate: (notification) => this.handleSessionUpdate(notification),
        onPermissionRequest: (request, signal) => this.handlePermissionRequest(request, signal),
        onExit: (process, reason) => this.handleHarnessExit(process, reason),
      },
      `${this.config.dataDir}/logs`,
    );
    this.harnessesByLaunch.set(key, harness);
    return harness;
  }

  /** A test host's Claude Code starts its sessions on the test model, rather than switching to it once a session runs. */
  private testModelEnvironment({ harness, profileId }: Launch): Record<string, string> {
    const { model } = this.config.testModelOverride;
    return harness === "claude" && profileId === null && model ? { ANTHROPIC_MODEL: model } : {};
  }

  /** Where scripts the agent starts reach the host (scripts/mirador-message), and the mirador command they do it with. */
  private scriptEnvironment(path: string | undefined) {
    return { MIRADOR_URL: this.config.appOrigin, MIRADOR_SCRIPT_TOKEN: this.config.scriptToken, ...miradorCommandEnvironment(path) };
  }

  private existingProfile(profileId: string) {
    const profile = this.store.findProfile(profileId);
    if (!profile) throw new Error("This conversation's profile was deleted. Pick another profile at the top of the conversation.");
    return profile;
  }

  private handleSessionUpdate(notification: acp.SessionNotification) {
    const conversationId = this.conversationBySession.get(notification.sessionId);
    if (!conversationId) {
      const pending = this.updatesForUnknownSessions.get(notification.sessionId) ?? [];
      this.updatesForUnknownSessions.set(notification.sessionId, [...pending, notification]);
      return;
    }
    const update = notification.update;
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
    if (finishedOne && runtime.openToolCalls.size === 0) this.steerQueuedMessages(conversationId).catch(() => {});
  }

  /** Messages that join the running turn; those the agent cannot take go back to the front of the queue, to go out when it ends. */
  private async steerQueuedMessages(conversationId: string) {
    const runtime = this.runtime(conversationId);
    const { harness } = runtime;
    const sessionId = this.get(conversationId).acpSessionId;
    if (!harness || !sessionId || this.holdsQueue(runtime) || !(await harness.canSteer())) return;
    const messages = queuedBeforeClear(runtime.queuedMessages).filter((message) => !message.afterTurn);
    const [first, ...rest] = messages;
    if (!first) return;
    this.setQueue(conversationId, runtime, runtime.queuedMessages.filter((message) => !messages.includes(message)));
    this.publish(this.get(conversationId));
    const events = this.store.listEvents(conversationId);
    const commands = awaitingDelivery(userCommandsIn(events));
    const reverts = pendingReverts(events);
    const text = messages.map((message) => message.text).join("\n\n");
    const imageIds = messages.flatMap((message) => message.imageIds);
    const injected = await this.promptContent(conversationId, withCommandOutputs(commands, withRevertNotes(reverts, text)), imageIds)
      .then((prompt) => harness.steer(sessionId, prompt))
      .catch(() => false);
    if (!injected) {
      this.setQueue(conversationId, runtime, [...messages, ...runtime.queuedMessages]);
      this.publish(this.get(conversationId));
      if (!runtime.running) this.sendNextQueuedMessage(conversationId);
      return;
    }
    this.appendUserMessage(conversationId, first, { commands, reverts });
    rest.forEach((message) => this.appendUserMessage(conversationId, message, { commands: [], reverts: [] }));
  }

  private async promptContent(conversationId: string, text: string, imageIds: string[]): Promise<acp.ContentBlock[]> {
    const images = await Promise.all(imageIds.map((imageId) => this.images.contentBlock(conversationId, imageId)));
    return [{ type: "text", text }, ...images];
  }

  private handlePermissionRequest(
    request: acp.RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<acp.RequestPermissionResponse> {
    const conversationId = this.conversationBySession.get(request.sessionId);
    if (!conversationId) return Promise.resolve({ outcome: { outcome: "cancelled" } });
    const allowOptionId = optionThatAllows(request.options);
    if (allowOptionId && this.get(conversationId).bypassPermissions) {
      return Promise.resolve({ outcome: { outcome: "selected", optionId: allowOptionId } });
    }
    const runtime = this.runtime(conversationId);
    const permissionId = crypto.randomUUID();
    this.append(conversationId, {
      type: "permission",
      permissionId,
      toolCall: request.toolCall,
      options: request.options,
    });
    this.notifications.notify(conversationId, { kind: "permission", tool: request.toolCall.title });
    return new Promise((resolve) => {
      const settle: PermissionResolver = (optionId) => {
        if (!runtime.pendingPermissions.delete(permissionId)) return;
        this.append(conversationId, { type: "permission-resolved", permissionId, optionId });
        if (this.store.hasConversation(conversationId)) this.publish(this.get(conversationId));
        resolve(optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } });
      };
      runtime.pendingPermissions.set(permissionId, { settle, allowOptionId, tool: request.toolCall.title ?? "a tool" });
      this.publish(this.get(conversationId));
      signal.addEventListener("abort", () => settle(null), { once: true });
    });
  }

  private handleHarnessExit(harness: HarnessProcess, reason: string) {
    this.harnessesByLaunch.forEach((current, key) => {
      if (current === harness) this.harnessesByLaunch.delete(key);
    });
    this.runtimes.forEach((runtime, conversationId) => {
      if (runtime.harness !== harness) return;
      runtime.harness = undefined;
      runtime.sessionId = undefined;
      runtime.pendingPermissions.forEach(({ settle }) => settle(null));
      if (runtime.running && !runtime.forceStopped) this.append(conversationId, { type: "error", message: `The ${harness.spec.label} agent process ${reason}.` });
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
  private recordTurnFailure(conversationId: string, error: unknown) {
    if (!isUsageLimitError(error)) {
      this.append(conversationId, { type: "error", message: errorMessage(error), ...(isAuthRequiredError(error) && { authRequired: true as const }) });
      return errorMessage(error);
    }
    const message = usageLimitMessage(error);
    const resetsAt = usageLimitResetIn(message);
    this.append(conversationId, { type: "error", message, usageLimit: { resetsAt } });
    this.waitForUsageLimitReset(conversationId, resetsAt);
    return message;
  }

  private waitForUsageLimitReset(conversationId: string, resetsAt: number | null) {
    const runtime = this.runtime(conversationId);
    const continuesAt =
      resetsAt !== null && runtime.automaticContinues < AUTOMATIC_CONTINUES_IN_A_ROW ? resetsAt + USAGE_LIMIT_RESET_MARGIN_MS : null;
    const timer =
      continuesAt === null
        ? undefined
        : setTimeout(() => this.continueAfterUsageLimit(conversationId, { automatically: true }), Math.max(0, continuesAt - Date.now()));
    runtime.usageLimit = { wait: { resetsAt, continuesAt }, timer };
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

  private sendNextQueuedMessage(conversationId: string) {
    const runtime = this.store.hasConversation(conversationId) ? this.runtime(conversationId) : undefined;
    const [next, ...rest] = runtime?.queuedMessages ?? [];
    if (!runtime || !next || this.holdsQueue(runtime)) return;
    this.setQueue(conversationId, runtime, rest);
    this.prompt(conversationId, next.text, { imageIds: next.imageIds, fromScript: next.fromScript, startsTurn: true }).catch(() => {});
  }

  private appendUserMessage(
    conversationId: string,
    { text, imageIds, fromScript, checkpoint }: Omit<QueuedMessage, "id"> & { checkpoint?: string | null },
    { commands, reverts }: { commands: UserCommand[]; reverts: Revert[] },
  ) {
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
    const title = firstLine.length > TITLE_LENGTH ? `${firstLine.slice(0, TITLE_LENGTH - 1)}…` : firstLine;
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
    const reason = turnEndReason(outcome, this.runtime(conversationId).queuedMessages.length > 0);
    if (!reason || this.stopping) return;
    this.notifications.notify(conversationId, reason);
    if (this.hub.isWatched(conversationId)) return;
    this.unseenTurnEnds.set(conversationId, reason.kind);
    this.store.setUnseenTurnEnd(conversationId, reason.kind);
  }

  private forgetUnseenTurnEnd(conversationId: string) {
    if (!this.unseenTurnEnds.delete(conversationId)) return false;
    this.store.setUnseenTurnEnd(conversationId, null);
    return true;
  }

  private activity(conversationId: string): Activity | null {
    const runtime = this.runtimes.get(conversationId);
    if (!runtime?.running) return null;
    return currentActivity(runtime.openToolCalls, [...runtime.pendingPermissions.values()].map(({ tool }) => tool));
  }

  private waitingFor(conversationId: string): WaitingFor | null {
    if ((this.runtimes.get(conversationId)?.pendingPermissions.size ?? 0) > 0) return "permission";
    if (this.conversationsWithQuestions.has(conversationId)) return "question";
    return this.unseenTurnEnds.get(conversationId) ?? null;
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
  }
}


const updatesTheAgentRecords = new Set<string>(["user_message_chunk", "agent_message_chunk", "agent_thought_chunk", "tool_call"]);

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

const endsTurn = ({ event }: StoredEvent) => event.type === "turn-end" || event.type === "error";

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
  const details = data === undefined || data === null ? "" : `: ${typeof data === "string" ? data : JSON.stringify(data)}`;
  return `${String(message ?? error)}${details}`;
}
