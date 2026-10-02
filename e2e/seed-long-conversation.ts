import { Database } from "bun:sqlite";

/** Run with bun while the test host is stopped: appends turns of a question and a three-line answer to a conversation. */
const [databasePath, conversationId, turns] = process.argv.slice(2);
const db = new Database(databasePath!);
const { seq: lastSeq } = db.query("SELECT max(seq) AS seq FROM events WHERE conversation_id = ?").get(conversationId!) as { seq: number | null };
const insert = db.prepare("INSERT INTO events (conversation_id, seq, at, event) VALUES (?, ?, ?, ?)");
const start = Date.now() - 3_600_000;

const events = Array.from({ length: Number(turns) }, (_, turn) => [
  { type: "user-message", text: `question ${turn}` },
  { type: "acp", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `answer ${turn}\n\nsecond line\n\nthird line` } } },
  { type: "turn-end", stopReason: "end_turn" },
]).flat();

db.transaction(() => events.forEach((event, index) => insert.run(conversationId!, (lastSeq ?? 0) + index + 1, start + index * 1000, JSON.stringify(event))))();
