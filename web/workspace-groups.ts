import { useSyncExternalStore } from "react";
import type { Workspace, WorkspaceGroup } from "../shared/model.ts";
import { movedBefore } from "../shared/sidebar-order.ts";

export interface GroupSection {
  group: WorkspaceGroup;
  workspaces: Workspace[];
}

/** The workspaces in no group, then each group with its own; one whose group is gone shows, and moves, as one in none. */
export function sidebarSections(workspaces: Workspace[], groups: WorkspaceGroup[]) {
  const groupIds = new Set(groups.map(({ id }) => id));
  const ungrouped = workspaces.filter(({ groupId }) => groupId === null || !groupIds.has(groupId)).map((workspace) => ({ ...workspace, groupId: null }));
  const grouped = groups.map((group): GroupSection => ({ group, workspaces: workspaces.filter(({ groupId }) => groupId === group.id) }));
  return { ungrouped, grouped };
}

/** A row of the sidebar a dragged workspace can land by, from top to bottom, with its edges on screen. */
export type SidebarRow =
  | { kind: "workspace"; id: string; groupId: string | null; top: number; bottom: number }
  | { kind: "group-heading"; groupId: string; top: number; bottom: number }
  /** Shown while a workspace is dragged and no workspace is in no group, so one can still leave its group. */
  | { kind: "ungrouped-drop"; top: number; bottom: number };

/** Where a dragged workspace lands: in a group or in none, just before a workspace of it or last. */
export interface WorkspaceDrop {
  groupId: string | null;
  beforeWorkspaceId: string | null;
}

const groupOf = (row: SidebarRow | undefined) => (row?.kind === "workspace" ? row.groupId : row?.kind === "group-heading" ? row.groupId : null);

function dropAbove(rows: SidebarRow[], index: number): WorkspaceDrop {
  const row = rows[index];
  if (row?.kind === "workspace") return { groupId: row.groupId, beforeWorkspaceId: row.id };
  return { groupId: groupOf(rows[index - 1]), beforeWorkspaceId: null };
}

/**
 * Over a group's heading, a workspace lands last in that group, folded or not; over a workspace, just before it or
 * just after it, whichever half the pointer is in; above everything, among the workspaces in no group.
 */
export function workspaceDropAt(rows: SidebarRow[], y: number): WorkspaceDrop {
  const index = rows.findIndex(({ bottom }) => y < bottom);
  const row = rows[index];
  if (!row || y < row.top) return dropAbove(rows, index === -1 ? rows.length : index);
  if (row.kind === "group-heading") return { groupId: row.groupId, beforeWorkspaceId: null };
  if (row.kind === "ungrouped-drop") return { groupId: null, beforeWorkspaceId: null };
  return dropAbove(rows, y < (row.top + row.bottom) / 2 ? index : index + 1);
}

/** Whether landing there changes the workspace's group or its place among the group's workspaces. */
export function movesWorkspace(workspaces: Workspace[], workspaceId: string, drop: WorkspaceDrop) {
  const moving = workspaces.find(({ id }) => id === workspaceId);
  if (!moving) return false;
  if (moving.groupId !== drop.groupId) return true;
  const ids = workspaces.filter(({ groupId }) => groupId === drop.groupId).map(({ id }) => id);
  return movedBefore(ids, workspaceId, drop.beforeWorkspaceId).join() !== ids.join();
}

const FOLDED_KEY = "mirador-folded-workspace-groups";

function storedFolded(): Set<string> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(FOLDED_KEY) ?? "[]");
    return new Set(Array.isArray(stored) ? stored.filter((id) => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

let folded = storedFolded();
const foldListeners = new Set<() => void>();

/** Folding is this browser's own, as pane layouts are: another window keeps its groups as it had them. */
export function setGroupFolded(groupId: string, fold: boolean) {
  if (folded.has(groupId) === fold) return;
  folded = new Set(folded);
  if (fold) folded.add(groupId);
  else folded.delete(groupId);
  try {
    localStorage.setItem(FOLDED_KEY, JSON.stringify([...folded]));
  } catch {}
  foldListeners.forEach((listener) => listener());
}

const subscribeToFolding = (listener: () => void) => {
  foldListeners.add(listener);
  return () => void foldListeners.delete(listener);
};

export const useFoldedGroups = () => useSyncExternalStore(subscribeToFolding, () => folded);
