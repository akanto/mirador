import { describe, expect, test } from "bun:test";
import type { Conversation, Workspace } from "../shared/model.ts";
import {
  adjacentConversation,
  adjacentWorkspaceConversation,
  conversationsIn,
  currentWorkspace,
  numberedConversation,
  type NavigationState,
} from "../web/navigation.ts";
import { matchesQuery } from "../web/Palette.tsx";
import { commandFor, type KeyPress } from "../web/shortcuts.ts";

const press = (code: string, modifiers: Partial<KeyPress> = {}, key = ""): KeyPress => ({
  key,
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...modifiers,
});

describe("commandFor", () => {
  test("uses Cmd on macOS and Ctrl elsewhere for the palette and the canvas", () => {
    expect(commandFor(press("KeyK", { metaKey: true }), "typing", true)).toEqual({ type: "palette" });
    expect(commandFor(press("KeyK", { ctrlKey: true }), "typing", true)).toBeNull();
    expect(commandFor(press("KeyK", { ctrlKey: true }), "typing", false)).toEqual({ type: "palette" });
    expect(commandFor(press("Backslash", { metaKey: true }), "typing", true)).toEqual({ type: "toggle-canvas" });
  });

  test("Option bindings match the physical key, so the character Option types (∆, ¡, †) does not matter", () => {
    expect(commandFor(press("ArrowDown", { altKey: true }), "typing", true)).toEqual({ type: "adjacent-conversation", step: 1 });
    expect(commandFor(press("ArrowUp", { altKey: true, shiftKey: true }), "typing", true)).toEqual({ type: "adjacent-workspace", step: -1 });
    expect(commandFor(press("Digit3", { altKey: true }, "£"), "typing", true)).toEqual({ type: "numbered-conversation", number: 3 });
    expect(commandFor(press("KeyT", { altKey: true }, "†"), "typing", true)).toEqual({ type: "new-conversation" });
    expect(commandFor(press("Digit0", { altKey: true }), "typing", true)).toBeNull();
    expect(commandFor(press("KeyT", { altKey: true, metaKey: true }), "typing", true)).toBeNull();
  });

  test("moving focus between panes leaves Cmd+Shift+arrows to text selection while the user is typing", () => {
    const focusCanvas = press("ArrowRight", { metaKey: true, shiftKey: true });
    expect(commandFor(focusCanvas, "empty-field", true)).toEqual({ type: "focus", pane: "canvas" });
    expect(commandFor(focusCanvas, "not-typing", true)).toEqual({ type: "focus", pane: "canvas" });
    expect(commandFor(focusCanvas, "typing", true)).toBeNull();
  });

  test("? opens the help only outside text fields", () => {
    const questionMark = press("Slash", { shiftKey: true }, "?");
    expect(commandFor(questionMark, "not-typing", true)).toEqual({ type: "help" });
    expect(commandFor(questionMark, "empty-field", true)).toBeNull();
    expect(commandFor(questionMark, "typing", true)).toBeNull();
  });
});

const workspace = (id: string): Workspace => ({ id, name: id, path: `/p/${id}`, defaultLaunch: { harness: "claude", profileId: null }, createdAt: 0 });

const conversation = (id: string, workspaceId: string, createdAt: number): Conversation => ({
  id,
  workspaceId,
  harness: "claude",
  profileId: null,
  title: id,
  titleSetByUser: false,
  acpSessionId: null,
  askMode: "wait",
  bypassPermissions: false,
  status: "idle",
  statusDetail: null,
  openInTerminal: null,
  configOptions: [],
  createdAt,
  updatedAt: createdAt,
});

describe("navigation", () => {
  const base: NavigationState = {
    workspaces: [workspace("a"), workspace("empty"), workspace("b")],
    conversations: [conversation("a-old", "a", 1), conversation("a-new", "a", 2), conversation("b-only", "b", 3)],
    selectedConversationId: null,
  };
  const selecting = (selectedConversationId: string | null) => ({ ...base, selectedConversationId });

  test("lists a workspace's conversations newest first, like the sidebar", () => {
    expect(conversationsIn(base, "a").map(({ id }) => id)).toEqual(["a-new", "a-old"]);
  });

  test("steps through conversations in sidebar order and wraps around", () => {
    expect(adjacentConversation(selecting("a-new"), 1)).toBe("a-old");
    expect(adjacentConversation(selecting("a-old"), 1)).toBe("b-only");
    expect(adjacentConversation(selecting("b-only"), 1)).toBe("a-new");
    expect(adjacentConversation(selecting("a-new"), -1)).toBe("b-only");
    expect(adjacentConversation(selecting(null), -1)).toBe("b-only");
  });

  test("steps through workspaces, skipping empty ones, and lands on the newest conversation", () => {
    expect(adjacentWorkspaceConversation(selecting("a-old"), 1)).toBe("b-only");
    expect(adjacentWorkspaceConversation(selecting("b-only"), 1)).toBe("a-new");
    expect(adjacentWorkspaceConversation(selecting("b-only"), -1)).toBe("a-new");
  });

  test("numbers conversations within the current workspace, the first workspace when nothing is selected", () => {
    expect(currentWorkspace(selecting(null))?.id).toBe("a");
    expect(numberedConversation(selecting(null), 2)).toBe("a-old");
    expect(numberedConversation(selecting("b-only"), 1)).toBe("b-only");
    expect(numberedConversation(selecting("b-only"), 2)).toBeNull();
  });

  test("has nowhere to go without conversations", () => {
    const empty = { workspaces: [workspace("a")], conversations: [], selectedConversationId: null };
    expect(adjacentConversation(empty, 1)).toBeNull();
    expect(adjacentWorkspaceConversation(empty, 1)).toBeNull();
    expect(numberedConversation(empty, 1)).toBeNull();
  });
});

describe("matchesQuery", () => {
  const entry = { label: "Refactor the login flow", detail: "billing-service" };

  test("needs every word somewhere in the label or detail, in any order and any case", () => {
    expect(matchesQuery("", entry)).toBe(true);
    expect(matchesQuery("login", entry)).toBe(true);
    expect(matchesQuery("BILLING refac", entry)).toBe(true);
    expect(matchesQuery("login checkout", entry)).toBe(false);
  });
});
