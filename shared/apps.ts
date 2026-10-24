/**
 * The plugin API version this Mirador speaks; a plugin.json names the one it was written for, and Mirador loads every
 * version up to its own. API 2 brought host tasks, streamed files and images in a view's message.
 */
export const APP_PLUGIN_API = 2;

/** A plugin's plugin.json, for a plugin that brings an app: a document that the agent and the user change together. */
export interface AppManifest {
  name: string;
  title: string;
  api: number;
  app: {
    /** The module, relative to the plugin's folder, whose exports are the plugin's AppHost. */
    host: string;
    /** One ES module, relative to the plugin's folder, that draws the app in a canvas frame with `window.mirador`. */
    view: string;
  };
  /**
   * A shell command that builds the plugin in its folder, e.g. "bun install && bun run build". Mirador runs it after
   * cloning the plugin's repo and after each update, with the Bun it runs on first on the PATH.
   */
  build?: string;
}

/**
 * What a plugin's host code exports. Mirador calls it in its own process: every call is guarded, and an error a call
 * throws is shown to whoever made the change, so its message should say what is wrong and what would work.
 */
export interface AppHost<Document = unknown> {
  /** Reads the document's file, bringing an older format up to date. */
  parse(text: string): Document;
  serialize(document: Document): string;
  /** Applies one operation. The inverse is the operation that undoes it; touched names what it changed, for the view to show. */
  apply(document: Document, operation: unknown): { document: Document; inverse: unknown; summary: string; touched?: string[] };
  /** The document in words, for the agent. */
  describe(document: Document): string;
  /** A new document, for opening the app on a file that doesn't exist yet. */
  create?(): Document;
  /** Longer work than an operation, such as rendering a video, by name: the agent runs one with app_run, the view with `mirador.run`. */
  tasks?: Record<string, AppTask<Document>>;
}

/** Runs outside the queue of operations, one task at a time for each document; whatever it throws is its problem, shown to whoever ran it. */
export interface AppTask<Document = unknown> {
  /** What it does, in a few words, for the agent and the view. */
  title: string;
  /** Resolves to a summary of what it did, for whoever ran it. */
  run(context: AppTaskContext<Document>): Promise<string>;
}

export interface AppTaskContext<Document = unknown> {
  /** The document as it was when the task started. */
  document: Document;
  /** The absolute path of a file in the folder of the document, or below it, which may not exist yet; a path that leads out of the folder throws. */
  file(path: string): string;
  documentFolder: string;
  workspaceFolder: string;
  pluginFolder: string;
  /** Who ran the task, for the operations it applies. */
  author: AppAuthor;
  /** Applies an operation as `apply` does, in turn with the others, as made by whoever ran the task. */
  apply(operation: unknown): Promise<AppChange>;
  /** How far along it is, from 0 to 1, or null when it can't tell; the views show it. */
  progress(done: number | null, text?: string): void;
  /** Aborted when the user stops the task, the app closes or Mirador stops. */
  signal: AbortSignal;
}

/** The latest task run on a document, as its views show it. */
export interface AppTaskState {
  name: string;
  title: string;
  runId: number;
  state: "running" | "done" | "failed" | "stopped";
  author: AppAuthor;
  done: number | null;
  text: string | null;
  /** What the task said it did, once done. */
  summary: string | null;
  problem: string | null;
  startedAt: number;
  endedAt: number | null;
}

export type AppAuthor =
  | { kind: "agent"; conversationId: string; turnSeq: number | null }
  | { kind: "you" }
  | { kind: "outside" };

export interface AppChange {
  seq: number;
  author: AppAuthor;
  summary: string;
  touched: string[];
  at: number;
}

/** An app the owner installed, and where its view's code is served on the canvas assets origin. */
export interface InstalledApp {
  name: string;
  title: string;
  viewPath: string;
}

/** An app open in a workspace, on one file of it. */
export interface OpenApp {
  workspaceId: string;
  app: string;
  title: string;
  file: string;
}

/** What a view shows: sent to the pages that have the app open, on every change. */
export interface AppDocumentState {
  workspaceId: string;
  app: string;
  document: unknown;
  lastChange: AppChange | null;
  /** Why the file's content isn't shown: it stopped parsing after an edit made outside Mirador. */
  problem: string | null;
  task: AppTaskState | null;
}

/** Where a plugin's folder came from: a git clone (its remote shown without credentials), a link to a folder elsewhere, or a plain folder. */
export type PluginSource =
  | { kind: "git"; remote: string | null; branch: string | null; commit: string; subject: string }
  | { kind: "linked"; target: string }
  | { kind: "folder" };

/** A folder in the plugins folder that holds a plugin.json, as the Plugins settings list it. */
export interface PluginInfo {
  folder: string;
  /** From its plugin.json, while that can be read. */
  name: string | null;
  title: string | null;
  source: PluginSource;
  /** Why it didn't load when Mirador started; null when it did. */
  problem: string | null;
  /** Added or updated since Mirador started, which loads it as it is now only at its next start. */
  waitsForRestart: boolean;
}

/** A commit an update would bring. */
export interface PluginCommit {
  commit: string;
  subject: string;
}

/** What an app's view keeps in a workspace, as its localStorage: text by key. */
export type AppStorageItems = Record<string, string>;

/** How much an app's view may keep in a workspace, counted as localStorage counts it: the characters of its keys and values. */
export const APP_STORAGE_CHARACTERS = 1024 * 1024;

export const storageCharacters = (items: AppStorageItems) => Object.entries(items).reduce((sum, [key, value]) => sum + key.length + value.length, 0);

export const appKey = ({ workspaceId, app }: { workspaceId: string; app: string }) => `${workspaceId}/${app}`;

/** Where the host serves a file next to the app's document to signed-in pages and devices, `path` named from the document's folder. */
export const appFileUrl = ({ workspaceId, app }: { workspaceId: string; app: string }, path: string) =>
  `/workspaces/${encodeURIComponent(workspaceId)}/apps/${encodeURIComponent(app)}/file?path=${encodeURIComponent(path)}`;

/** Where signed-in pages and devices ask for an address the view can stream a file next to the app's document from; POST, answered with an AppMediaGrant. */
export const appMediaGrantUrl = ({ workspaceId, app }: { workspaceId: string; app: string }, path: string) =>
  `/workspaces/${encodeURIComponent(workspaceId)}/apps/${encodeURIComponent(app)}/media?path=${encodeURIComponent(path)}`;

/** Where the canvas assets serve streamed files, so the canvas pages' policy lets media and images load from there. */
export const APP_MEDIA_PATH = "/media/";

/** The path on the canvas assets an app's view streams one file from, in ranges, for as long as the app stays open. */
export interface AppMediaGrant {
  path: string;
}

/** How many images one message from an app's view may carry. */
export const MAX_APP_PROMPT_IMAGES = 4;

/** The user's message from an app's view: it names the app and its file, so the agent knows what it is about. */
export function appPromptText({ title, file }: OpenApp, text: string) {
  return `About ${file}, open in ${title} (app_state reads it, apply changes it):\n\n${text.trim()}`;
}

export function isAppManifest(value: unknown): value is AppManifest {
  if (typeof value !== "object" || value === null) return false;
  const { name, title, api, app, build } = value as Partial<AppManifest>;
  return (
    typeof name === "string" &&
    /^[a-z0-9][a-z0-9-]*$/.test(name) &&
    typeof title === "string" &&
    typeof api === "number" &&
    typeof app === "object" &&
    app !== null &&
    typeof app.host === "string" &&
    typeof app.view === "string" &&
    (build === undefined || typeof build === "string")
  );
}
