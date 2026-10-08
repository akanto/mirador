import type { FileChanges } from "../shared/changes.ts";
import type { StoredEvent } from "../shared/model.ts";

/**
 * The newest event after which the files may differ: a finished tool call, the user's own command ending, a turn
 * starting or ending, or an undo. The Changes view loads again whenever it moves.
 */
export function changesRefreshPoint(events: StoredEvent[]): number {
  return events.findLast(({ event }) => {
    if (event.type === "acp") return event.update.sessionUpdate === "tool_call_update" && (event.update.status === "completed" || event.update.status === "failed");
    return event.type === "user-message" || event.type === "turn-end" || event.type === "user-command-ended" || event.type === "revert";
  })?.seq ?? 0;
}

/** Where IDEA should open the file: its first changed line, or the line a removal left off at; the top for the agent's own snippets. */
export function firstChangedLine(changes: FileChanges): number {
  const rows = changes.source === "files" ? (changes.diffs[0]?.hunks[0]?.rows ?? []) : [];
  const firstChange = rows.findIndex(({ kind }) => kind !== "context");
  if (firstChange === -1) return 1;
  return rows.slice(firstChange).find(({ newLine }) => newLine !== null)?.newLine ?? (rows[firstChange - 1]?.newLine ?? 0) + 1;
}
