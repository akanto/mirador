import { Database } from "bun:sqlite";

export interface DemoConversation {
  id: string;
  title: string;
  /** When its first event happened; the rest follow a minute apart. */
  minutesAgo: number;
  unseenTurnEnd?: "finished" | "error";
  events: unknown[];
}

export interface Demo {
  workspaceColors: Record<string, string>;
  conversations: DemoConversation[];
}

/** Run with bun while the test host is stopped: names, colours and fills conversations, as a person's own would look. */
const [databasePath, demoJson] = process.argv.slice(2);
const db = new Database(databasePath!);
const demo = JSON.parse(demoJson!) as Demo;
const insertEvent = db.prepare("INSERT INTO events (conversation_id, seq, at, event) VALUES (?, ?, ?, ?)");
const lastSeq = db.prepare("SELECT max(seq) AS seq FROM events WHERE conversation_id = ?");
const nameConversation = db.prepare("UPDATE conversations SET title = ?, title_set_by_user = 1, unseen_turn_end = ? WHERE id = ?");
const colorWorkspace = db.prepare("UPDATE workspaces SET color = ? WHERE path = ?");
const minute = 60_000;

db.transaction(() => {
  Object.entries(demo.workspaceColors).forEach(([path, color]) => colorWorkspace.run(color, path));
  demo.conversations.forEach(({ id, title, minutesAgo, unseenTurnEnd, events }) => {
    nameConversation.run(title, unseenTurnEnd ?? null, id);
    const { seq } = lastSeq.get(id) as { seq: number | null };
    const start = Date.now() - minutesAgo * minute;
    events.forEach((event, index) => insertEvent.run(id, (seq ?? 0) + index + 1, start + index * minute, JSON.stringify(event)));
  });
})();
