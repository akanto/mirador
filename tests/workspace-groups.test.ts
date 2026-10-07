import { describe, expect, test } from "bun:test";
import type { Workspace, WorkspaceGroup } from "../shared/model.ts";
import { movesWorkspace, sidebarSections, workspaceDropAt, type SidebarRow } from "../web/workspace-groups.ts";

const workspace = (id: string, groupId: string | null, position: number): Workspace => ({
  id,
  name: id,
  path: `/p/${id}`,
  defaultLaunch: { harness: "claude", profileId: null },
  color: null,
  position,
  groupId,
  createdAt: 0,
});

const group = (id: string, position: number): WorkspaceGroup => ({ id, name: id, position, createdAt: 0 });

describe("sidebar sections", () => {
  test("the workspaces in no group come first, then each group's own, in their order", () => {
    const workspaces = [workspace("a", "g2", 0), workspace("b", null, 1), workspace("c", "g1", 2), workspace("d", "g2", 3)];
    const { ungrouped, grouped } = sidebarSections(workspaces, [group("g2", 0), group("g1", 1), group("empty", 2)]);
    expect(ungrouped.map(({ id }) => id)).toEqual(["b"]);
    expect(grouped.map(({ group, workspaces }) => [group.id, workspaces.map(({ id }) => id)])).toEqual([
      ["g2", ["a", "d"]],
      ["g1", ["c"]],
      ["empty", []],
    ]);
  });

  test("a workspace whose group is gone shows with those in no group", () => {
    const { ungrouped, grouped } = sidebarSections([workspace("a", "gone", 0)], []);
    expect(ungrouped.map(({ id, groupId }) => [id, groupId])).toEqual([["a", null]]);
    expect(grouped).toEqual([]);
  });
});

describe("where a dragged workspace lands", () => {
  // a 0-20, b 20-40 in none; heading of g1 40-50 with c 50-70; heading of folded g2 70-80; heading of empty g3 80-90.
  const rows: SidebarRow[] = [
    { kind: "workspace", id: "a", groupId: null, top: 0, bottom: 20 },
    { kind: "workspace", id: "b", groupId: null, top: 20, bottom: 40 },
    { kind: "group-heading", groupId: "g1", top: 40, bottom: 50 },
    { kind: "workspace", id: "c", groupId: "g1", top: 50, bottom: 70 },
    { kind: "group-heading", groupId: "g2", top: 70, bottom: 80 },
    { kind: "group-heading", groupId: "g3", top: 80, bottom: 90 },
  ];

  test("over a workspace's upper half, just before it, in its group", () => {
    expect(workspaceDropAt(rows, 25)).toEqual({ groupId: null, beforeWorkspaceId: "b" });
    expect(workspaceDropAt(rows, 55)).toEqual({ groupId: "g1", beforeWorkspaceId: "c" });
  });

  test("over a workspace's lower half, before the next of its group, or last in it when a heading follows", () => {
    expect(workspaceDropAt(rows, 15)).toEqual({ groupId: null, beforeWorkspaceId: "b" });
    expect(workspaceDropAt(rows, 35)).toEqual({ groupId: null, beforeWorkspaceId: null });
    expect(workspaceDropAt(rows, 65)).toEqual({ groupId: "g1", beforeWorkspaceId: null });
  });

  test("over a heading, last in that group, whether it is unfolded, folded or empty", () => {
    expect(workspaceDropAt(rows, 45)).toEqual({ groupId: "g1", beforeWorkspaceId: null });
    expect(workspaceDropAt(rows, 75)).toEqual({ groupId: "g2", beforeWorkspaceId: null });
    expect(workspaceDropAt(rows, 85)).toEqual({ groupId: "g3", beforeWorkspaceId: null });
  });

  test("above everything, first among the workspaces in no group; below everything, last in the last group", () => {
    expect(workspaceDropAt(rows, -10)).toEqual({ groupId: null, beforeWorkspaceId: "a" });
    expect(workspaceDropAt(rows, 200)).toEqual({ groupId: "g3", beforeWorkspaceId: null });
  });

  test("in the gap above a heading, last in the group above it, or in none above the first", () => {
    const spaced: SidebarRow[] = [
      { kind: "group-heading", groupId: "g1", top: 10, bottom: 20 },
      { kind: "workspace", id: "c", groupId: "g1", top: 20, bottom: 40 },
      { kind: "group-heading", groupId: "g2", top: 50, bottom: 60 },
    ];
    expect(workspaceDropAt(spaced, 5)).toEqual({ groupId: null, beforeWorkspaceId: null });
    expect(workspaceDropAt(spaced, 45)).toEqual({ groupId: "g1", beforeWorkspaceId: null });
  });

  test("with no workspace in no group, over the place shown for it, out of its group", () => {
    const withPlace: SidebarRow[] = [{ kind: "ungrouped-drop", top: 0, bottom: 20 }, ...rows.slice(2)];
    expect(workspaceDropAt(withPlace, 10)).toEqual({ groupId: null, beforeWorkspaceId: null });
  });
});

describe("whether a drop moves the workspace", () => {
  const workspaces = [workspace("a", null, 0), workspace("b", null, 1), workspace("c", "g1", 2)];

  test("to another group it does, even to the same place", () => {
    expect(movesWorkspace(workspaces, "b", { groupId: "g1", beforeWorkspaceId: null })).toBe(true);
    expect(movesWorkspace(workspaces, "c", { groupId: null, beforeWorkspaceId: null })).toBe(true);
  });

  test("within its group only when its place among the group's workspaces changes", () => {
    expect(movesWorkspace(workspaces, "a", { groupId: null, beforeWorkspaceId: "b" })).toBe(false);
    expect(movesWorkspace(workspaces, "a", { groupId: null, beforeWorkspaceId: null })).toBe(true);
    expect(movesWorkspace(workspaces, "c", { groupId: "g1", beforeWorkspaceId: null })).toBe(false);
  });
});
