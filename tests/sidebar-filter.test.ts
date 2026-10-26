import { describe, expect, test } from "bun:test";
import type { Conversation, Workspace, WorkspaceGroup } from "../shared/model.ts";
import { filterSidebar } from "../shared/sidebar-filter.ts";
import { sidebarItems, type SidebarItem } from "../shared/sidebar-order.ts";

const workspace = (name: string, groupId: string | null = null): Workspace => ({
  id: name,
  name,
  path: `/home/me/${name}`,
  defaultLaunch: { harness: "claude", profileId: null },
  color: null,
  position: 0,
  groupId,
  createdAt: 0,
});

const group = (name: string): WorkspaceGroup => ({ id: name, name, position: 0, createdAt: 0 });

const titles: Record<string, string[]> = {
  mirador: ["Queue steering", "Sidebar filter"],
  "jira-intel": ["Train the classifier", "Queue of tickets"],
  dotfiles: ["Hyprland keys"],
};

const conversationsIn = (workspaceId: string) => (titles[workspaceId] ?? []).map((title) => ({ id: `${workspaceId}/${title}`, workspaceId, title }) as Conversation);

const items = sidebarItems([workspace("mirador"), workspace("jira-intel", "work"), workspace("dotfiles", "home")], [group("work"), group("home")]);

function shown(query: string) {
  const filtered = filterSidebar(items, conversationsIn, query);
  const listed = (each: Workspace) => `${each.name} [${filtered.conversationsOf.get(each.id)!.map(({ title }) => title).join(", ")}]`;
  return filtered.items.map((item: SidebarItem) => (item.kind === "workspace" ? listed(item.workspace) : `${item.group.name}: ${item.workspaces.map(listed).join(" ")}`));
}

describe("filtering the sidebar", () => {
  test("keeps only the conversations whose titles match, in the workspaces they are in, ignoring case", () => {
    expect(shown("queue")).toEqual(["mirador [Queue steering]", "work: jira-intel [Queue of tickets]"]);
  });

  test("a workspace's name keeps all its conversations", () => {
    expect(shown("MIRA")).toEqual(["mirador [Queue steering, Sidebar filter]"]);
  });

  test("a group's name keeps its workspaces with all their conversations", () => {
    expect(shown("home")).toEqual(["home: dotfiles [Hyprland keys]"]);
  });

  test("words can name the workspace and the conversation together, in any order", () => {
    expect(shown("queue jira")).toEqual(["work: jira-intel [Queue of tickets]"]);
    expect(shown("steering mirador")).toEqual(["mirador [Queue steering]"]);
  });

  test("an empty query keeps everything, and one that matches nothing keeps nothing", () => {
    expect(shown("  ")).toHaveLength(3);
    expect(shown("nowhere")).toEqual([]);
  });
});
