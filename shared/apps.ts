/** The plugin API version this Mirador speaks; a plugin.json names the one it was written for. */
export const APP_PLUGIN_API = 1;

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
}

export const appKey = ({ workspaceId, app }: { workspaceId: string; app: string }) => `${workspaceId}/${app}`;

/** The user's message from an app's view: it names the app and its file, so the agent knows what it is about. */
export function appPromptText({ title, file }: OpenApp, text: string) {
  return `About ${file}, open in ${title} (app_state reads it, apply changes it):\n\n${text.trim()}`;
}

export function isAppManifest(value: unknown): value is AppManifest {
  if (typeof value !== "object" || value === null) return false;
  const { name, title, api, app } = value as Partial<AppManifest>;
  return (
    typeof name === "string" &&
    /^[a-z0-9][a-z0-9-]*$/.test(name) &&
    typeof title === "string" &&
    typeof api === "number" &&
    typeof app === "object" &&
    app !== null &&
    typeof app.host === "string" &&
    typeof app.view === "string"
  );
}
