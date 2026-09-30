import { Database } from "bun:sqlite";
import type {
  AskMode,
  CanvasItem,
  Conversation,
  ConversationEvent,
  HarnessId,
  Launch,
  Profile,
  StoredEvent,
  Workspace,
} from "../shared/model.ts";

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
  CREATE TABLE IF NOT EXISTS canvas_items (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL, item TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, environment TEXT NOT NULL, prelaunch TEXT NOT NULL, created_at INTEGER NOT NULL);
`;

const addedColumns = [
  { table: "workspaces", column: "default_profile_id", definition: "TEXT" },
  { table: "conversations", column: "profile_id", definition: "TEXT" },
  { table: "workspaces", column: "default_harness", definition: "TEXT NOT NULL DEFAULT 'claude'" },
  { table: "profiles", column: "harness", definition: "TEXT NOT NULL DEFAULT 'claude'" },
  { table: "conversations", column: "title_set_by_user", definition: "INTEGER NOT NULL DEFAULT 0" },
];

type WorkspaceRow = {
  id: string;
  name: string;
  path: string;
  default_harness: HarnessId;
  default_profile_id: string | null;
  created_at: number;
};

type ProfileRow = { id: string; name: string; harness: HarnessId; environment: string; prelaunch: string; created_at: number };

type ConversationRow = {
  id: string;
  workspace_id: string;
  harness: HarnessId;
  profile_id: string | null;
  title: string;
  title_set_by_user: number;
  acp_session_id: string | null;
  ask_mode: AskMode;
  config_options: string;
  created_at: number;
  updated_at: number;
};

const toWorkspace = (row: WorkspaceRow): Workspace => ({
  id: row.id,
  name: row.name,
  path: row.path,
  defaultLaunch: { harness: row.default_harness, profileId: row.default_profile_id },
  createdAt: row.created_at,
});

const toProfile = (row: ProfileRow): Profile => ({
  id: row.id,
  name: row.name,
  harness: row.harness,
  environment: row.environment,
  prelaunch: row.prelaunch,
  createdAt: row.created_at,
});

const toConversation = (row: ConversationRow): Conversation => ({
  id: row.id,
  workspaceId: row.workspace_id,
  harness: row.harness,
  profileId: row.profile_id,
  title: row.title,
  titleSetByUser: row.title_set_by_user === 1,
  acpSessionId: row.acp_session_id,
  askMode: row.ask_mode,
  status: "idle",
  statusDetail: null,
  openInTerminal: null,
  configOptions: JSON.parse(row.config_options),
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
    this.db.run(schema);
    this.addMissingColumns();
  }

  close() {
    this.db.close();
  }

  listWorkspaces(): Workspace[] {
    return this.db.query("SELECT * FROM workspaces ORDER BY created_at").all().map((row) => toWorkspace(row as WorkspaceRow));
  }

  findWorkspace(id: string): Workspace | undefined {
    const row = this.db.query("SELECT * FROM workspaces WHERE id = ?").get(id) as any;
    return row ? toWorkspace(row) : undefined;
  }

  findWorkspaceByPath(path: string): Workspace | undefined {
    const row = this.db.query("SELECT * FROM workspaces WHERE path = ?").get(path) as any;
    return row ? toWorkspace(row) : undefined;
  }

  insertWorkspace(workspace: Workspace) {
    this.db
      .query("INSERT INTO workspaces (id, name, path, default_harness, default_profile_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(workspace.id, workspace.name, workspace.path, workspace.defaultLaunch.harness, workspace.defaultLaunch.profileId, workspace.createdAt);
  }

  setWorkspaceDefaultLaunch(workspaceId: string, launch: Launch) {
    this.db
      .query("UPDATE workspaces SET default_harness = ?, default_profile_id = ? WHERE id = ?")
      .run(launch.harness, launch.profileId, workspaceId);
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

  findConversation(id: string): Conversation | undefined {
    const row = this.db.query("SELECT * FROM conversations WHERE id = ?").get(id) as ConversationRow | null;
    return row ? toConversation(row) : undefined;
  }

  insertConversation(conversation: Conversation) {
    this.db
      .query(
        `INSERT INTO conversations (id, workspace_id, harness, profile_id, title, title_set_by_user, acp_session_id, ask_mode, config_options, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        JSON.stringify(conversation.configOptions),
        conversation.createdAt,
        conversation.updatedAt,
      );
  }

  updateConversation(conversation: Conversation) {
    this.db
      .query(
        `UPDATE conversations SET profile_id = ?, title = ?, title_set_by_user = ?, acp_session_id = ?, ask_mode = ?, config_options = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        conversation.profileId,
        conversation.title,
        Number(conversation.titleSetByUser),
        conversation.acpSessionId,
        conversation.askMode,
        JSON.stringify(conversation.configOptions),
        conversation.updatedAt,
        conversation.id,
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
        `INSERT INTO profiles (id, name, harness, environment, prelaunch, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, environment = excluded.environment, prelaunch = excluded.prelaunch`,
      )
      .run(profile.id, profile.name, profile.harness, profile.environment, profile.prelaunch, profile.createdAt);
  }

  deleteProfile(id: string) {
    this.db.query("DELETE FROM profiles WHERE id = ?").run(id);
    this.db.query("UPDATE workspaces SET default_profile_id = NULL WHERE default_profile_id = ?").run(id);
  }

  appendEvent(conversationId: string, event: ConversationEvent): StoredEvent {
    const seq = this.allocateSeq(conversationId);
    const stored = { seq, at: Date.now(), event };
    this.db
      .query("INSERT INTO events (conversation_id, seq, at, event) VALUES (?, ?, ?, ?)")
      .run(conversationId, seq, stored.at, JSON.stringify(event));
    return stored;
  }

  listEvents(conversationId: string): StoredEvent[] {
    return this.db
      .query("SELECT seq, at, event FROM events WHERE conversation_id = ? ORDER BY seq")
      .all(conversationId)
      .map((row: any) => ({ seq: row.seq, at: row.at, event: JSON.parse(row.event) }));
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
