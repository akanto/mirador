import { Database } from "bun:sqlite";
import type { AvailableCommand } from "@agentclientprotocol/sdk";
import type {
  AskMode,
  CanvasItem,
  Conversation,
  Device,
  Machine,
  ConversationEvent,
  HarnessId,
  JobWait,
  JoinRequest,
  Launch,
  Profile,
  PromptTemplate,
  PublicAddress,
  QueuedMessage,
  StoredEvent,
  Workspace,
} from "../shared/model.ts";
import { isCanvasUse, isPastel, type CanvasUse, type Pastel } from "../shared/model.ts";
import { defaultPromptTemplates } from "../shared/prompt-templates.ts";

const TYPED_IN_WORKSPACE_LIMIT = 100;
const deviceColumns = "id, name, joined_at AS joinedAt, last_seen_at AS lastSeenAt";
const joinRequestColumns = `id, secret_hash AS secretHash, name, from_address AS fromAddress, tailscale_user AS tailscaleUser,
  authority_fingerprint AS authorityFingerprint, commitment, machine_nonce AS machineNonce, requester_nonce AS requesterNonce, answer, expires_at AS expiresAt`;

/** What the machine keeps about a join request; only the hash of the secret the device asking polls with. */
export interface StoredJoinRequest extends JoinRequest {
  secretHash: string;
  /** Of the certificate authority the device asking checked this machine's certificate against; null when it trusted it otherwise. */
  authorityFingerprint: string | null;
  commitment: string;
  machineNonce: string;
  /** Null until the device asking reveals it; only then does the request wait for approval. */
  requesterNonce: string | null;
  answer: "approved" | "denied" | null;
}

const schema = `
  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    harness TEXT NOT NULL, title TEXT NOT NULL, acp_session_id TEXT, ask_mode TEXT NOT NULL,
    config_options TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS events (
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL, at INTEGER NOT NULL, event TEXT NOT NULL, PRIMARY KEY (conversation_id, seq));
  CREATE INDEX IF NOT EXISTS events_by_type ON events (json_extract(event, '$.type'));
  CREATE TABLE IF NOT EXISTS canvas_items (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL, item TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, environment TEXT NOT NULL, prelaunch TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS prompt_templates (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, joined_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS invites (code_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS join_requests (
    id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, name TEXT NOT NULL, from_address TEXT NOT NULL, tailscale_user TEXT,
    authority_fingerprint TEXT, commitment TEXT NOT NULL, machine_nonce TEXT NOT NULL, requester_nonce TEXT, answer TEXT, expires_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS machines (id TEXT PRIMARY KEY, name TEXT NOT NULL, origin TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS job_waits (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    job TEXT NOT NULL, ssh_host TEXT, message TEXT NOT NULL, resume INTEGER NOT NULL, since INTEGER NOT NULL);
`;

const addedColumns = [
  { table: "workspaces", column: "default_profile_id", definition: "TEXT" },
  { table: "machines", column: "relay_port", definition: "INTEGER" },
  { table: "machines", column: "device_token", definition: "TEXT" },
  { table: "machines", column: "authority", definition: "TEXT" },
  { table: "machines", column: "color", definition: "TEXT" },
  { table: "conversations", column: "profile_id", definition: "TEXT" },
  { table: "workspaces", column: "default_harness", definition: "TEXT NOT NULL DEFAULT 'claude'" },
  { table: "profiles", column: "harness", definition: "TEXT NOT NULL DEFAULT 'claude'" },
  { table: "conversations", column: "title_set_by_user", definition: "INTEGER NOT NULL DEFAULT 0" },
  { table: "conversations", column: "bypass_permissions", definition: "INTEGER NOT NULL DEFAULT 0" },
  { table: "conversations", column: "queued_messages", definition: "TEXT NOT NULL DEFAULT '[]'" },
  { table: "conversations", column: "unseen_turn_end", definition: "TEXT" },
  { table: "workspaces", column: "position", definition: "INTEGER NOT NULL DEFAULT 0" },
  { table: "conversations", column: "position", definition: "INTEGER NOT NULL DEFAULT 0" },
  { table: "profiles", column: "mode", definition: "TEXT" },
  { table: "profiles", column: "bypass_permissions", definition: "INTEGER NOT NULL DEFAULT 0" },
  { table: "profiles", column: "ask_mode", definition: "TEXT NOT NULL DEFAULT 'wait'" },
  { table: "workspaces", column: "color", definition: "TEXT" },
];

/** A turn that ended while nobody looked at its conversation, until someone opens it. */
export type UnseenTurnEnd = "finished" | "error";

type WorkspaceRow = {
  id: string;
  name: string;
  path: string;
  default_harness: HarnessId;
  default_profile_id: string | null;
  color: string | null;
  position: number;
  created_at: number;
};

type ProfileRow = {
  id: string;
  name: string;
  harness: HarnessId;
  environment: string;
  prelaunch: string;
  mode: string | null;
  bypass_permissions: number;
  ask_mode: AskMode;
  created_at: number;
};

type ConversationRow = {
  id: string;
  workspace_id: string;
  harness: HarnessId;
  profile_id: string | null;
  title: string;
  title_set_by_user: number;
  acp_session_id: string | null;
  ask_mode: AskMode;
  bypass_permissions: number;
  config_options: string;
  queued_messages: string;
  position: number;
  created_at: number;
  updated_at: number;
};

const toWorkspace = (row: WorkspaceRow): Workspace => ({
  id: row.id,
  name: row.name,
  path: row.path,
  defaultLaunch: { harness: row.default_harness, profileId: row.default_profile_id },
  color: isPastel(row.color) ? row.color : null,
  position: row.position,
  createdAt: row.created_at,
});

const toProfile = (row: ProfileRow): Profile => ({
  id: row.id,
  name: row.name,
  harness: row.harness,
  environment: row.environment,
  prelaunch: row.prelaunch,
  mode: row.mode,
  bypassPermissions: row.bypass_permissions === 1,
  askMode: row.ask_mode,
  createdAt: row.created_at,
});

type MachineRow = { id: string; name: string; origin: string; created_at: number; relay_port: number | null; joined: number; color: string | null };

const MACHINE_COLUMNS = "SELECT id, name, origin, created_at, relay_port, device_token IS NOT NULL AS joined, color FROM machines";

type JobWaitRow = { id: string; conversation_id: string; job: string; ssh_host: string | null; message: string; resume: number; since: number };

const toMachine = (row: unknown): Machine => {
  const { id, name, origin, created_at, relay_port, joined, color } = row as MachineRow;
  return { id, name, origin, createdAt: created_at, relayPort: relay_port, joined: joined === 1, color: isPastel(color) ? color : null };
};

const toConversation = (row: ConversationRow): Conversation => ({
  id: row.id,
  workspaceId: row.workspace_id,
  harness: row.harness,
  profileId: row.profile_id,
  title: row.title,
  titleSetByUser: row.title_set_by_user === 1,
  acpSessionId: row.acp_session_id,
  askMode: row.ask_mode,
  bypassPermissions: row.bypass_permissions === 1,
  status: "idle",
  statusDetail: null,
  openInTerminal: null,
  contextUsage: null,
  queuedMessages: JSON.parse(row.queued_messages),
  usageLimit: null,
  jobWaits: [],
  waitingFor: null,
  configOptions: JSON.parse(row.config_options),
  position: row.position,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class Store {
  private readonly db: Database;
  private readonly nextSeq = new Map<string, number>();

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA foreign_keys = ON");
    // mirador invite writes here while the host runs.
    this.db.run("PRAGMA busy_timeout = 5000");
    const hadPromptTemplates = this.hasTable("prompt_templates");
    this.db.run(schema);
    this.addMissingColumns();
    if (!hadPromptTemplates) defaultPromptTemplates.forEach((template) => this.savePromptTemplate({ ...template, createdAt: Date.now() }));
  }

  private hasTable(name: string) {
    return this.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== null;
  }

  close() {
    this.db.close();
  }

  listWorkspaces(): Workspace[] {
    return this.db.query("SELECT * FROM workspaces ORDER BY position, created_at").all().map((row) => toWorkspace(row as WorkspaceRow));
  }

  findWorkspace(id: string): Workspace | undefined {
    const row = this.db.query("SELECT * FROM workspaces WHERE id = ?").get(id) as any;
    return row ? toWorkspace(row) : undefined;
  }

  findWorkspaceByPath(path: string): Workspace | undefined {
    const row = this.db.query("SELECT * FROM workspaces WHERE path = ?").get(path) as any;
    return row ? toWorkspace(row) : undefined;
  }

  /** Adds the workspace after the others. */
  insertWorkspace(workspace: Omit<Workspace, "position" | "color">): Workspace {
    const { next: position } = this.db.query("SELECT COALESCE(MAX(position) + 1, 0) AS next FROM workspaces").get() as { next: number };
    this.db
      .query("INSERT INTO workspaces (id, name, path, default_harness, default_profile_id, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(workspace.id, workspace.name, workspace.path, workspace.defaultLaunch.harness, workspace.defaultLaunch.profileId, position, workspace.createdAt);
    return { ...workspace, color: null, position };
  }

  /** Numbers the workspaces' positions in the given order. */
  setWorkspaceOrder(workspaceIds: string[]) {
    this.setPositions("workspaces", workspaceIds);
  }

  setWorkspaceDefaultLaunch(workspaceId: string, launch: Launch) {
    this.db
      .query("UPDATE workspaces SET default_harness = ?, default_profile_id = ? WHERE id = ?")
      .run(launch.harness, launch.profileId, workspaceId);
  }

  setWorkspaceColor(workspaceId: string, color: Pastel | null) {
    this.db.query("UPDATE workspaces SET color = ? WHERE id = ?").run(color, workspaceId);
  }

  deleteWorkspace(id: string) {
    this.db.query("DELETE FROM workspaces WHERE id = ?").run(id);
  }

  listConversations(): Conversation[] {
    return this.db
      .query("SELECT * FROM conversations ORDER BY created_at")
      .all()
      .map((row) => toConversation(row as ConversationRow));
  }

  hasConversation(id: string): boolean {
    return this.db.query("SELECT 1 FROM conversations WHERE id = ?").get(id) !== null;
  }

  findConversation(id: string): Conversation | undefined {
    const row = this.db.query("SELECT * FROM conversations WHERE id = ?").get(id) as ConversationRow | null;
    return row ? toConversation(row) : undefined;
  }

  /** Adds the conversation after the others of its workspace. */
  insertConversation(conversation: Omit<Conversation, "position">): Conversation {
    const { next: position } = this.db
      .query("SELECT COALESCE(MAX(position) + 1, 0) AS next FROM conversations WHERE workspace_id = ?")
      .get(conversation.workspaceId) as { next: number };
    this.db
      .query(
        `INSERT INTO conversations (id, workspace_id, harness, profile_id, title, title_set_by_user, acp_session_id, ask_mode, bypass_permissions, config_options, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        conversation.id,
        conversation.workspaceId,
        conversation.harness,
        conversation.profileId,
        conversation.title,
        Number(conversation.titleSetByUser),
        conversation.acpSessionId,
        conversation.askMode,
        Number(conversation.bypassPermissions),
        JSON.stringify(conversation.configOptions),
        position,
        conversation.createdAt,
        conversation.updatedAt,
      );
    return { ...conversation, position };
  }

  /** Numbers the conversations' positions in the given order. */
  setConversationOrder(conversationIds: string[]) {
    this.setPositions("conversations", conversationIds);
  }

  updateConversation(conversation: Conversation) {
    this.db
      .query(
        `UPDATE conversations SET profile_id = ?, title = ?, title_set_by_user = ?, acp_session_id = ?, ask_mode = ?, bypass_permissions = ?, config_options = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        conversation.profileId,
        conversation.title,
        Number(conversation.titleSetByUser),
        conversation.acpSessionId,
        conversation.askMode,
        Number(conversation.bypassPermissions),
        JSON.stringify(conversation.configOptions),
        conversation.updatedAt,
        conversation.id,
      );
  }

  saveQueuedMessages(conversationId: string, messages: QueuedMessage[]) {
    this.db.query("UPDATE conversations SET queued_messages = ? WHERE id = ?").run(JSON.stringify(messages), conversationId);
  }

  setUnseenTurnEnd(conversationId: string, turnEnd: UnseenTurnEnd | null) {
    this.db.query("UPDATE conversations SET unseen_turn_end = ? WHERE id = ?").run(turnEnd, conversationId);
  }

  listUnseenTurnEnds(): [conversationId: string, turnEnd: UnseenTurnEnd][] {
    return (this.db.query("SELECT id, unseen_turn_end FROM conversations WHERE unseen_turn_end IS NOT NULL").all() as { id: string; unseen_turn_end: UnseenTurnEnd }[]).map(
      ({ id, unseen_turn_end }) => [id, unseen_turn_end],
    );
  }

  deleteConversation(id: string) {
    this.db.query("DELETE FROM conversations WHERE id = ?").run(id);
    this.nextSeq.delete(id);
  }

  listProfiles(): Profile[] {
    return this.db.query("SELECT * FROM profiles ORDER BY name COLLATE NOCASE").all().map((row) => toProfile(row as ProfileRow));
  }

  findProfile(id: string): Profile | undefined {
    const row = this.db.query("SELECT * FROM profiles WHERE id = ?").get(id) as any;
    return row ? toProfile(row) : undefined;
  }

  saveProfile(profile: Profile) {
    this.db
      .query(
        `INSERT INTO profiles (id, name, harness, environment, prelaunch, mode, bypass_permissions, ask_mode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, environment = excluded.environment, prelaunch = excluded.prelaunch,
           mode = excluded.mode, bypass_permissions = excluded.bypass_permissions, ask_mode = excluded.ask_mode`,
      )
      .run(
        profile.id,
        profile.name,
        profile.harness,
        profile.environment,
        profile.prelaunch,
        profile.mode,
        Number(profile.bypassPermissions),
        profile.askMode,
        profile.createdAt,
      );
  }

  deleteProfile(id: string) {
    this.db.query("DELETE FROM profiles WHERE id = ?").run(id);
    this.db.query("UPDATE workspaces SET default_profile_id = NULL WHERE default_profile_id = ?").run(id);
  }

  canvasUse(): CanvasUse {
    const value = (this.db.query("SELECT value FROM settings WHERE key = 'canvas_use'").get() as { value: string } | null)?.value;
    return isCanvasUse(value) ? value : "often";
  }

  setCanvasUse(canvasUse: CanvasUse) {
    this.db.query("INSERT INTO settings (key, value) VALUES ('canvas_use', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(canvasUse);
  }

  private setting(key: string) {
    return (this.db.query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | null)?.value ?? null;
  }

  private setSetting(key: string, value: string | null) {
    if (value === null) return void this.db.query("DELETE FROM settings WHERE key = ?").run(key);
    this.db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  /** The address the running host uses, for commands started from a shell that lacks its environment. */
  rememberedPublicAddress(): PublicAddress | null {
    const value = this.setting("public_address");
    return value ? (JSON.parse(value) as PublicAddress) : null;
  }

  rememberPublicAddress(address: PublicAddress | null) {
    this.setSetting("public_address", address && JSON.stringify(address));
  }

  /** Of the certificate authority the running host serves with, for invite links that commands make. */
  rememberedAuthorityFingerprint() {
    return this.setting("authority_fingerprint");
  }

  rememberAuthorityFingerprint(fingerprint: string | null) {
    this.setSetting("authority_fingerprint", fingerprint);
  }

  listPromptTemplates(): PromptTemplate[] {
    return this.db
      .query("SELECT id, name, text, created_at AS createdAt FROM prompt_templates ORDER BY name COLLATE NOCASE")
      .all() as PromptTemplate[];
  }

  findPromptTemplate(id: string): PromptTemplate | undefined {
    return (this.db.query("SELECT id, name, text, created_at AS createdAt FROM prompt_templates WHERE id = ?").get(id) as PromptTemplate | null) ?? undefined;
  }

  /** Creates the template, or changes the name and text of the one with its id. */
  savePromptTemplate({ id, name, text, createdAt }: PromptTemplate) {
    this.db
      .query(
        `INSERT INTO prompt_templates (id, name, text, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, text = excluded.text`,
      )
      .run(id, name, text, createdAt);
  }

  deletePromptTemplate(id: string) {
    this.db.query("DELETE FROM prompt_templates WHERE id = ?").run(id);
  }

  listMachines(): Machine[] {
    return this.db.query(`${MACHINE_COLUMNS} ORDER BY name COLLATE NOCASE`).all().map(toMachine);
  }

  findMachine(id: string): Machine | undefined {
    const row = this.db.query(`${MACHINE_COLUMNS} WHERE id = ?`).get(id);
    return row ? toMachine(row) : undefined;
  }

  findMachineByOrigin(origin: string): Machine | undefined {
    const row = this.db.query(`${MACHINE_COLUMNS} WHERE origin = ?`).get(origin);
    return row ? toMachine(row) : undefined;
  }

  insertMachine({ id, name, origin, createdAt }: Pick<Machine, "id" | "name" | "origin" | "createdAt">) {
    this.db.query("INSERT INTO machines (id, name, origin, created_at) VALUES (?, ?, ?, ?)").run(id, name, origin, createdAt);
  }

  setMachineRelayPort(id: string, port: number) {
    this.db.query("UPDATE machines SET relay_port = ? WHERE id = ?").run(port, id);
  }

  /** The token this host signs in to the machine with; never sent to pages. */
  machineDeviceToken(id: string): string | null {
    return (this.db.query("SELECT device_token AS token FROM machines WHERE id = ?").get(id) as { token: string | null } | null)?.token ?? null;
  }

  setMachineDeviceToken(id: string, token: string) {
    this.db.query("UPDATE machines SET device_token = ? WHERE id = ?").run(token, id);
  }

  /** The certificate authority this host checks the machine's certificate against, when the computer's own don't vouch for it. */
  machineAuthority(id: string): string | null {
    return (this.db.query("SELECT authority FROM machines WHERE id = ?").get(id) as { authority: string | null } | null)?.authority ?? null;
  }

  setMachineAuthority(id: string, authority: string | null) {
    this.db.query("UPDATE machines SET authority = ? WHERE id = ?").run(authority, id);
  }

  setMachineColor(id: string, color: Pastel | null) {
    this.db.query("UPDATE machines SET color = ? WHERE id = ?").run(color, id);
  }

  deleteMachine(id: string) {
    this.db.query("DELETE FROM machines WHERE id = ?").run(id);
  }

  addJobWait(conversationId: string, { id, job, sshHost, message, resume, since }: JobWait) {
    this.db
      .query("INSERT INTO job_waits (id, conversation_id, job, ssh_host, message, resume, since) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, conversationId, JSON.stringify(job), sshHost, message, resume ? 1 : 0, since);
  }

  listJobWaits(): { conversationId: string; wait: JobWait }[] {
    return this.db
      .query("SELECT * FROM job_waits ORDER BY since")
      .all()
      .map((row) => {
        const { id, conversation_id, job, ssh_host, message, resume, since } = row as JobWaitRow;
        return { conversationId: conversation_id, wait: { id, job: JSON.parse(job), sshHost: ssh_host, message, resume: resume === 1, since } };
      });
  }

  deleteJobWait(id: string) {
    this.db.query("DELETE FROM job_waits WHERE id = ?").run(id);
  }

  addInvite(codeHash: string, expiresAt: number) {
    this.db.query("INSERT INTO invites (code_hash, expires_at) VALUES (?, ?)").run(codeHash, expiresAt);
  }

  /** Removes the invite, and every expired one; whether it was there and still valid. */
  takeInvite(codeHash: string, now: number) {
    const { changes } = this.db.query("DELETE FROM invites WHERE code_hash = ? AND expires_at > ?").run(codeHash, now);
    this.db.query("DELETE FROM invites WHERE expires_at <= ?").run(now);
    return changes > 0;
  }

  addJoinRequest(request: StoredJoinRequest) {
    const { id, secretHash, name, fromAddress, tailscaleUser, authorityFingerprint, commitment, machineNonce, expiresAt } = request;
    this.db
      .query(
        `INSERT INTO join_requests (id, secret_hash, name, from_address, tailscale_user, authority_fingerprint, commitment, machine_nonce, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, secretHash, name, fromAddress, tailscaleUser, authorityFingerprint, commitment, machineNonce, expiresAt);
  }

  /** Unless it expired; every expired one goes. */
  findJoinRequest(id: string, now: number): StoredJoinRequest | undefined {
    this.db.query("DELETE FROM join_requests WHERE expires_at <= ?").run(now);
    return (this.db.query(`SELECT ${joinRequestColumns} FROM join_requests WHERE id = ?`).get(id) as StoredJoinRequest | null) ?? undefined;
  }

  /** Not yet approved or denied, oldest first; every expired one goes. */
  unansweredJoinRequests(now: number): StoredJoinRequest[] {
    this.db.query("DELETE FROM join_requests WHERE expires_at <= ?").run(now);
    return this.db.query(`SELECT ${joinRequestColumns} FROM join_requests WHERE answer IS NULL ORDER BY expires_at`).all() as StoredJoinRequest[];
  }

  setJoinRequestNonce(id: string, nonce: string) {
    this.db.query("UPDATE join_requests SET requester_nonce = ? WHERE id = ?").run(nonce, id);
  }

  answerJoinRequest(id: string, answer: "approved" | "denied") {
    this.db.query("UPDATE join_requests SET answer = ? WHERE id = ?").run(answer, id);
  }

  deleteJoinRequest(id: string) {
    this.db.query("DELETE FROM join_requests WHERE id = ?").run(id);
  }

  listDevices(): Device[] {
    return this.db.query(`SELECT ${deviceColumns} FROM devices ORDER BY joined_at`).all() as Device[];
  }

  findDeviceByTokenHash(tokenHash: string): Device | undefined {
    return (this.db.query(`SELECT ${deviceColumns} FROM devices WHERE token_hash = ?`).get(tokenHash) as Device | null) ?? undefined;
  }

  insertDevice({ id, name, joinedAt, lastSeenAt }: Device, tokenHash: string) {
    this.db
      .query("INSERT INTO devices (id, name, token_hash, joined_at, last_seen_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, name, tokenHash, joinedAt, lastSeenAt);
  }

  setDeviceLastSeen(id: string, at: number) {
    this.db.query("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(at, id);
  }

  deleteDevice(id: string) {
    this.db.query("DELETE FROM devices WHERE id = ?").run(id);
  }

  appendEvent(conversationId: string, event: ConversationEvent): StoredEvent {
    const seq = this.allocateSeq(conversationId);
    const stored = { seq, at: Date.now(), event };
    this.db
      .query("INSERT INTO events (conversation_id, seq, at, event) VALUES (?, ?, ?, ?)")
      .run(conversationId, seq, stored.at, JSON.stringify(event));
    return stored;
  }

  lastEventSeq(conversationId: string): number {
    return (this.db.query("SELECT MAX(seq) AS max FROM events WHERE conversation_id = ?").get(conversationId) as { max: number | null }).max ?? 0;
  }

  listEvents(conversationId: string): StoredEvent[] {
    return this.listEventsFrom(conversationId, 0);
  }

  listEventsFrom(conversationId: string, fromSeq: number): StoredEvent[] {
    return this.listEventsBetween(conversationId, fromSeq, Number.MAX_SAFE_INTEGER);
  }

  /** The events from `fromSeq` up to, not including, `beforeSeq`. */
  listEventsBetween(conversationId: string, fromSeq: number, beforeSeq: number): StoredEvent[] {
    return this.db
      .query("SELECT seq, at, event FROM events WHERE conversation_id = ? AND seq >= ? AND seq < ? ORDER BY seq")
      .all(conversationId, fromSeq, beforeSeq)
      .map((row: any) => ({ seq: row.seq, at: row.at, event: JSON.parse(row.event) }));
  }

  findEvent(conversationId: string, seq: number): StoredEvent | null {
    return this.listEventsBetween(conversationId, seq, seq + 1)[0] ?? null;
  }

  /**
   * Where the last `turns` turns before `beforeSeq` start, each turn at the user's message. When no turn comes before
   * them, they start with the conversation itself, so what precedes its first message comes along.
   */
  latestTurns(conversationId: string, turns: number) {
    return this.turnsBefore(conversationId, Number.MAX_SAFE_INTEGER, turns);
  }

  turnsBefore(conversationId: string, beforeSeq: number, turns: number): { fromSeq: number; hasEarlier: boolean } {
    const [firstTurn, earlierTurn] = this.db
      .query(
        `SELECT seq FROM events WHERE conversation_id = ? AND seq < ? AND json_extract(event, '$.type') = 'user-message'
         ORDER BY seq DESC LIMIT 2 OFFSET ?`,
      )
      .all(conversationId, beforeSeq, turns - 1) as { seq: number }[];
    return earlierTurn ? { fromSeq: firstTurn!.seq, hasEarlier: true } : { fromSeq: 0, hasEarlier: false };
  }

  /**
   * The commands the agent last listed in this conversation, or else in another with the same agent and profile,
   * this workspace's first: an agent lists them only once a session starts, which is after the first message.
   */
  latestAvailableCommands({ id, workspaceId, harness, profileId }: Pick<Conversation, "id" | "workspaceId" | "harness" | "profileId">): AvailableCommand[] {
    const row = this.db
      .query(
        `SELECT e.event FROM events e JOIN conversations c ON c.id = e.conversation_id
         WHERE c.harness = ? AND c.profile_id IS ? AND json_extract(e.event, '$.update.sessionUpdate') = 'available_commands_update'
         ORDER BY c.id = ? DESC, c.workspace_id = ? DESC, e.at DESC, e.seq DESC LIMIT 1`,
      )
      .get(harness, profileId, id, workspaceId) as { event: string } | null;
    return row ? JSON.parse(row.event).update.availableCommands : [];
  }

  /** The messages and shell commands typed in the workspace's conversations other than this one, newest first. */
  typedInWorkspace(workspaceId: string, exceptConversationId: string, limit = TYPED_IN_WORKSPACE_LIMIT): ConversationEvent[] {
    const rows = this.db
      .query(
        `SELECT e.event FROM events e JOIN conversations c ON c.id = e.conversation_id
         WHERE c.workspace_id = ? AND c.id != ? AND json_extract(e.event, '$.type') IN ('user-message', 'user-command')
         ORDER BY e.at DESC, e.seq DESC LIMIT ?`,
      )
      .all(workspaceId, exceptConversationId, limit) as { event: string }[];
    return rows.map(({ event }) => JSON.parse(event));
  }

  /** The messages and shell commands typed in the conversation before the given event, newest first. */
  typedBefore(conversationId: string, beforeSeq: number, limit = TYPED_IN_WORKSPACE_LIMIT): ConversationEvent[] {
    const rows = this.db
      .query(
        `SELECT event FROM events WHERE conversation_id = ? AND seq < ? AND json_extract(event, '$.type') IN ('user-message', 'user-command')
         ORDER BY seq DESC LIMIT ?`,
      )
      .all(conversationId, beforeSeq, limit) as { event: string }[];
    return rows.map(({ event }) => JSON.parse(event));
  }

  /** The newest event that starts or ends a turn, or ends a wait for a usage limit's reset. */
  latestTurnEvent(conversationId: string): ConversationEvent | null {
    const row = this.db
      .query(
        `SELECT event FROM events WHERE conversation_id = ?
         AND json_extract(event, '$.type') IN ('user-message', 'turn-end', 'error', 'usage-limit-wait-stopped') ORDER BY seq DESC LIMIT 1`,
      )
      .get(conversationId) as { event: string } | null;
    return row ? JSON.parse(row.event) : null;
  }

  lastUserMessageAt(conversationId: string): number | null {
    const row = this.db
      .query("SELECT at FROM events WHERE conversation_id = ? AND json_extract(event, '$.type') = 'user-message' ORDER BY seq DESC LIMIT 1")
      .get(conversationId) as { at: number } | null;
    return row?.at ?? null;
  }

  saveCanvasItem(item: CanvasItem) {
    this.db
      .query(
        `INSERT INTO canvas_items (id, conversation_id, created_at, item) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET item = excluded.item`,
      )
      .run(item.id, item.conversationId, item.createdAt, JSON.stringify(item));
  }

  findCanvasItem(id: string): CanvasItem | undefined {
    const row = this.db.query("SELECT item FROM canvas_items WHERE id = ?").get(id) as { item: string } | null;
    return row ? JSON.parse(row.item) : undefined;
  }

  listCanvasItems(conversationId: string): CanvasItem[] {
    return this.db
      .query("SELECT item FROM canvas_items WHERE conversation_id = ? ORDER BY created_at")
      .all(conversationId)
      .map((row: any) => JSON.parse(row.item));
  }

  listCanvasItemsWithStatus(status: CanvasItem["status"]): CanvasItem[] {
    return this.db
      .query("SELECT item FROM canvas_items")
      .all()
      .map((row: any) => JSON.parse(row.item) as CanvasItem)
      .filter((item) => item.status === status);
  }

  private setPositions(table: "workspaces" | "conversations", ids: string[]) {
    const setPosition = this.db.query(`UPDATE ${table} SET position = ? WHERE id = ?`);
    this.db.transaction(() => ids.forEach((id, position) => setPosition.run(position, id)))();
  }

  private addMissingColumns() {
    addedColumns.forEach(({ table, column, definition }) => {
      const columns = this.db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (!columns.some(({ name }) => name === column)) this.db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    });
  }

  private allocateSeq(conversationId: string) {
    const current =
      this.nextSeq.get(conversationId) ??
      ((this.db.query("SELECT MAX(seq) AS max FROM events WHERE conversation_id = ?").get(conversationId) as any)?.max ??
        0) + 1;
    this.nextSeq.set(conversationId, current + 1);
    return current;
  }
}
