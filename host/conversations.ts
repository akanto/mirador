import { realpath } from "node:fs/promises";
import type * as acp from "@agentclientprotocol/sdk";
import type {
  AdoptMode,
  AskMode,
  ContextUsage,
  Conversation,
  ConversationEvent,
  ConversationStatus,
  ExternalSession,
  Launch,
  QueuedMessage,
  TerminalActivity,
  Workspace,
} from "../shared/model.ts";
import { CANVAS_SERVER_NAME, harnessSpec, profileEnvironment, sessionMeta } from "./acp/harnesses.ts";
import { HarnessProcess, type ConfigValue } from "./acp/harness.ts";
import type { HostConfig } from "./config.ts";
import type { Hub } from "./hub.ts";
import type { NotifierMute } from "./notifier.ts";
import { assertLaunchable } from "./profiles.ts";
import type { Store } from "./store.ts";
import { claudeConfigDir } from "./terminal-sessions.ts";

const UNTITLED = "New conversation";
const MAX_TITLE_LENGTH = 200;
const LISTED_SESSIONS = 30;
const TITLE_LENGTH = 60;

type PermissionResolver = (optionId: string | null) => void;

interface PendingPermission {
  settle: PermissionResolver;
  allowOptionId: string | null;
}

interface Runtime {
  sessionId?: Promise<string>;
  harness?: HarnessProcess;
  running: boolean;
  pendingPermissions: Map<string, PendingPermission>;
  queuedMessages: QueuedMessage[];
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

  constructor(
    private readonly store: Store,
    private readonly hub: Hub,
    private readonly config: HostConfig,
    private readonly notifier: NotifierMute,
  ) {
    this.cancelPermissionsOrphanedByRestart();
  }

  list(): Conversation[] {
    return this.store.listConversations().map((conversation) => this.withRuntimeStatus(conversation));
  }

  get(conversationId: string): Conversation {
    const conversation = this.store.findConversation(conversationId);
    if (!conversation) throw new Error(`Unknown conversation ${conversationId}`);
    return this.withRuntimeStatus(conversation);
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
    const now = Date.now();
    const conversation: Conversation = {
      id: crypto.randomUUID(),
      workspaceId,
      harness: launch.harness,
      profileId: launch.profileId,
      title,
      titleSetByUser: false,
      acpSessionId: null,
      askMode: "wait",
      bypassPermissions: false,
      status: "idle",
      statusDetail: null,
      openInTerminal: null,
      contextUsage: null,
      queuedMessages: [],
      configOptions: [],
      createdAt: now,
      updatedAt: now,
    };
    this.store.insertConversation(conversation);
    this.publish(conversation);
    return conversation;
  }

  delete(conversationId: string) {
    const conversation = this.get(conversationId);
    if (conversation.acpSessionId) {
      this.cancel(conversationId).catch(() => {});
      this.notifier.unmute(conversation.acpSessionId);
      this.conversationBySession.delete(conversation.acpSessionId);
    }
    this.runtimes.delete(conversationId);
    this.statusOverrides.delete(conversationId);
    this.terminalActivity.delete(conversationId);
    this.contextUsage.delete(conversationId);
    this.store.deleteConversation(conversationId);
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
  async setProfile(conversationId: string, profileId: string | null) {
    const runtime = this.runtime(conversationId);
    await runtime.sessionId?.catch(() => {});
    if (runtime.running) throw new Error("Stop the current turn before changing the profile.");
    const conversation = this.get(conversationId);
    if (conversation.profileId === profileId) return;
    assertLaunchable(this.store, { harness: conversation.harness, profileId });
    const released = this.releaseSession(runtime, conversation.acpSessionId);
    this.save({
      ...conversation,
      profileId,
      acpSessionId: this.agentHasRecorded(conversationId) ? conversation.acpSessionId : null,
      configOptions: conversation.configOptions.filter(({ id }) => id !== "model"),
    });
    this.append(conversationId, { type: "profile-changed", profileName: profileId && this.existingProfile(profileId).name });
    this.ensureSession(conversationId, async () => {
      this.setStatus(conversationId, "starting", "Switching profile…");
      await released;
      const sessionId = await this.openSession(conversationId);
      this.setStatus(conversationId, "idle");
      return sessionId;
    }).catch(() => {});
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

  async prompt(conversationId: string, text: string) {
    const runtime = this.runtime(conversationId);
    if (runtime.running) throw new Error("The agent is still working on the previous message.");
    runtime.running = true;
    this.retitleFromFirstMessage(conversationId, text);
    this.append(conversationId, { type: "user-message", text });
    try {
      this.setStatus(conversationId, "starting");
      const sessionId = await this.ensureSession(conversationId);
      this.setStatus(conversationId, "running");
      const response = await this.harnessFor(this.get(conversationId)).prompt(sessionId, text);
      this.append(conversationId, { type: "turn-end", stopReason: response.stopReason });
    } catch (error) {
      this.append(conversationId, { type: "error", message: errorMessage(error) });
    } finally {
      runtime.running = false;
      this.setStatus(conversationId, "idle");
    }
    this.sendNextQueuedMessage(conversationId);
  }

  /** Sends `text` as the next user message, queueing it while a turn is running. */
  async send(conversationId: string, text: string) {
    const runtime = this.runtime(conversationId);
    if (!runtime.running) return this.prompt(conversationId, text);
    runtime.queuedMessages = [...runtime.queuedMessages, { id: crypto.randomUUID(), text }];
    this.publish(this.get(conversationId));
  }

  editQueuedMessage(conversationId: string, messageId: string, text: string) {
    if (!text.trim()) return this.removeQueuedMessage(conversationId, messageId);
    this.replaceQueue(conversationId, (queue) => queue.map((message) => (message.id === messageId ? { ...message, text } : message)), messageId);
  }

  removeQueuedMessage(conversationId: string, messageId: string) {
    this.replaceQueue(conversationId, (queue) => queue.filter(({ id }) => id !== messageId), messageId);
  }

  async cancel(conversationId: string) {
    const runtime = this.runtime(conversationId);
    runtime.pendingPermissions.forEach(({ settle }) => settle(null));
    const conversation = this.get(conversationId);
    if (runtime.running && conversation.acpSessionId) {
      await this.harnessFor(conversation).cancel(conversation.acpSessionId);
    }
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
      .map(({ profileId }) => claudeConfigDir(profileEnvironment(profileId === null ? null : (this.store.findProfile(profileId) ?? null))));
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

  shutdown() {
    this.harnessesByLaunch.forEach((harness) => harness.stop());
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
   * Claude Code keeps no record of a session until the agent works on a message in it, so a session
   * without a finished turn, agent output or replayed history cannot be resumed.
   */
  private agentHasRecorded(conversationId: string) {
    return this.store
      .listEvents(conversationId)
      .some(({ event }) => event.type === "turn-end" || (event.type === "acp" && updatesTheAgentRecords.has(event.update.sessionUpdate)));
  }

  private async openSession(conversationId: string): Promise<string> {
    const conversation = this.get(conversationId);
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
    this.setStatus(conversationId, "idle");
    return loadedId;
  }

  private sessionRequest(conversationId: string, workspace: Workspace) {
    const { harness } = this.get(conversationId);
    return { cwd: workspace.path, mcpServers: [this.canvasServerFor(conversationId)], _meta: sessionMeta(harness) };
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

  /** A resumed session starts from the agent's defaults, so re-apply what the user had chosen. */
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
    const harness = new HarnessProcess(
      harnessSpec(launch.harness, launch.profileId === null ? null : this.existingProfile(launch.profileId)),
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
    return new Promise((resolve) => {
      const settle: PermissionResolver = (optionId) => {
        if (!runtime.pendingPermissions.delete(permissionId)) return;
        this.append(conversationId, { type: "permission-resolved", permissionId, optionId });
        resolve(optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } });
      };
      runtime.pendingPermissions.set(permissionId, { settle, allowOptionId });
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
      if (runtime.running) this.append(conversationId, { type: "error", message: `The ${harness.spec.label} agent process ${reason}.` });
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

  private replaceQueue(conversationId: string, change: (queue: QueuedMessage[]) => QueuedMessage[], messageId: string) {
    const runtime = this.runtime(conversationId);
    if (!runtime.queuedMessages.some(({ id }) => id === messageId)) throw new Error("That message was already sent.");
    runtime.queuedMessages = change(runtime.queuedMessages);
    this.publish(this.get(conversationId));
  }

  private sendNextQueuedMessage(conversationId: string) {
    const runtime = this.runtimes.get(conversationId);
    const [next, ...rest] = runtime?.queuedMessages ?? [];
    if (!runtime || !next) return;
    runtime.queuedMessages = rest;
    this.prompt(conversationId, next.text).catch(() => {});
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
      runtime = { running: false, pendingPermissions: new Map(), queuedMessages: [] };
      this.runtimes.set(conversationId, runtime);
    }
    return runtime;
  }

  /** A turn that was still running when its conversation got deleted ends without a trace. */
  private append(conversationId: string, event: ConversationEvent) {
    if (!this.store.hasConversation(conversationId)) return;
    const stored = this.store.appendEvent(conversationId, event);
    this.hub.publishToConversation(conversationId, { type: "conversation.event", conversationId, event: stored });
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
      queuedMessages: this.runtimes.get(conversation.id)?.queuedMessages ?? [],
    };
  }

  private save(conversation: Conversation) {
    const updated = { ...conversation, updatedAt: Date.now() };
    this.store.updateConversation(updated);
    this.publish(updated);
  }

  private publish(conversation: Conversation) {
    this.hub.broadcast({ type: "conversation.upserted", conversation: this.withRuntimeStatus(conversation) });
  }
}

const updatesTheAgentRecords = new Set<string>(["user_message_chunk", "agent_message_chunk", "agent_thought_chunk", "tool_call"]);

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
