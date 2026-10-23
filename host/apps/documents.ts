import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { appKey, type AppAuthor, type AppChange, type AppDocumentState, type OpenApp } from "../../shared/apps.ts";
import type { Store } from "../store.ts";
import { AppProblem, appViewPath, installedApp, messageOf, type AppPlugin } from "./plugins.ts";

/** Editors save in several writes; an edit made outside Mirador is read once the file has been quiet this long. */
const OUTSIDE_EDIT_SETTLE_MS = 150;
const CHANGES_DESCRIBED = 10;
const MAX_APP_FILE_BYTES = 10 * 1024 * 1024;

/** Why a view can't have the file it asked for, with the HTTP status that says so. */
export class AppFileRefused extends AppProblem {
  constructor(
    readonly status: 400 | 403 | 404 | 413,
    message: string,
  ) {
    super(message);
  }
}

export interface AppPublisher {
  openAppsChanged(openApps: OpenApp[]): void;
  stateChanged(state: AppDocumentState): void;
}

/** Kept with its operation and inverse, so undo can come without reshaping the log. */
interface LoggedChange extends AppChange {
  operation: unknown;
  inverse: unknown;
}

interface AppDocument {
  plugin: AppPlugin;
  workspaceId: string;
  /** Relative to the workspace. */
  file: string;
  path: string;
  document: unknown;
  problem: string | null;
  /** Lives as long as this run of the host; the file is what lasts. */
  changes: LoggedChange[];
  /** Of the content Mirador knows the file holds: its own last write, or the outside edit it last read. */
  knownHash: string | null;
  /** Operations and outside edits take turns on the document, one at a time. */
  queue: Promise<unknown>;
  watcher: FSWatcher | null;
  settling: ReturnType<typeof setTimeout> | undefined;
}

const hashOf = (text: string) => createHash("sha256").update(text).digest("hex");

const openAppOf = (opened: AppDocument): OpenApp => ({
  workspaceId: opened.workspaceId,
  app: opened.plugin.manifest.name,
  title: opened.plugin.manifest.title,
  file: opened.file,
});

const publicChange = ({ operation: _, inverse: __, ...change }: LoggedChange): AppChange => change;

const stateOf = (opened: AppDocument): AppDocumentState => ({
  workspaceId: opened.workspaceId,
  app: opened.plugin.manifest.name,
  document: opened.document,
  lastChange: opened.changes.length > 0 ? publicChange(opened.changes.at(-1)!) : null,
  problem: opened.problem,
});

const authorWords = (author: AppAuthor) => ({ agent: "agent", you: "user", outside: "edited outside Mirador" })[author.kind];

function fileInWorkspace(workspacePath: string, file: string) {
  const root = resolve(workspacePath);
  const path = resolve(root, file);
  if (!path.startsWith(root + sep)) throw new AppProblem(`${file} is outside the workspace; give a path inside ${root}.`);
  return { path, file: relative(root, path) };
}

const realPathOrNull = (path: string) => {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
};

const isInside = (folder: string, path: string) => path.startsWith(folder + sep);

/** The document each workspace has open in each app: operations from the agent and the user change it one at a time, and the file stores it. */
export class AppDocuments {
  private readonly documents = new Map<string, AppDocument>();

  constructor(
    private readonly store: Store,
    private readonly plugins: AppPlugin[],
    private readonly publisher: AppPublisher,
    private readonly maxFileBytes = MAX_APP_FILE_BYTES,
  ) {}

  installed() {
    return this.plugins.map(installedApp);
  }

  /** The view's code for a path the canvas assets serve, or null when no plugin's view is there. */
  viewCode(pathname: string): Uint8Array<ArrayBuffer> | null {
    return this.plugins.find((plugin) => appViewPath(plugin) === pathname)?.view.code ?? null;
  }

  /** The real path of a file in the folder of the app's open document, or below it: links that lead out of the folder are refused. */
  fileNextToDocument(workspaceId: string, appName: string, path: unknown): string {
    const opened = this.documents.get(appKey({ workspaceId, app: appName }));
    if (!opened) throw new AppFileRefused(404, `${appName} isn't open in this workspace.`);
    if (typeof path !== "string" || path === "" || isAbsolute(path)) throw new AppFileRefused(400, "Give the file's path relative to the document's folder.");
    const folder = realPathOrNull(dirname(opened.path));
    if (!folder) throw new AppFileRefused(404, "The document's folder doesn't exist.");
    const refusedAsOutside = new AppFileRefused(403, `${path} is outside the document's folder.`);
    const wanted = resolve(folder, path);
    if (!isInside(folder, wanted)) throw refusedAsOutside;
    const file = realPathOrNull(wanted);
    if (!file) throw new AppFileRefused(404, `${path} doesn't exist.`);
    if (!isInside(folder, file)) throw refusedAsOutside;
    const stats = statSync(file);
    if (!stats.isFile()) throw new AppFileRefused(400, `${path} isn't a file.`);
    if (stats.size > this.maxFileBytes) throw new AppFileRefused(413, `${path} is larger than ${this.maxFileBytes / 1024 / 1024} MB.`);
    return file;
  }

  openApps(): OpenApp[] {
    return [...this.documents.values()].map(openAppOf);
  }

  state(workspaceId: string, app: string): AppDocumentState | null {
    const opened = this.documents.get(appKey({ workspaceId, app }));
    return opened ? stateOf(opened) : null;
  }

  async reopenAll() {
    for (const { workspaceId, app, file } of this.store.listOpenApps()) {
      try {
        await this.open(workspaceId, app, file);
      } catch (error) {
        console.warn(`Couldn't open ${app} on ${file} again: ${messageOf(error)}`);
      }
    }
  }

  async open(workspaceId: string, appName: string, file: string): Promise<OpenApp> {
    const plugin = this.plugin(appName);
    const workspace = this.store.findWorkspace(workspaceId);
    if (!workspace) throw new AppProblem("That workspace no longer exists.");
    const target = fileInWorkspace(workspace.path, file);
    const already = this.documents.get(appKey({ workspaceId, app: appName }));
    if (already?.file === target.file && !already.problem) return openAppOf(already);
    const text = existsSync(target.path) ? readFileSync(target.path, "utf8") : null;
    const document = text === null ? this.created(plugin, target.file) : this.guarded(() => plugin.host.parse(text));
    this.close(workspaceId, appName);
    const opened: AppDocument = {
      plugin,
      workspaceId,
      ...target,
      document,
      problem: null,
      changes: [],
      knownHash: text === null ? null : hashOf(text),
      queue: Promise.resolve(),
      watcher: null,
      settling: undefined,
    };
    if (text === null) await this.write(opened, this.guarded(() => plugin.host.serialize(document)));
    this.documents.set(appKey(openAppOf(opened)), opened);
    this.store.saveOpenApp(workspaceId, appName, opened.file);
    this.watch(opened);
    this.publisher.openAppsChanged(this.openApps());
    this.publisher.stateChanged(stateOf(opened));
    return openAppOf(opened);
  }

  apply(workspaceId: string, appName: string | undefined, operation: unknown, author: AppAuthor): Promise<AppChange> {
    const opened = this.openIn(workspaceId, appName);
    return this.queued(opened, async () => {
      if (opened.problem) throw new AppProblem(`${opened.file} can't be read: ${opened.problem}. Fix the file, or open it again with app_open.`);
      const { host, manifest } = opened.plugin;
      const applied = this.guarded(() => host.apply(opened.document, operation));
      if (typeof applied?.summary !== "string") throw new AppProblem(`${manifest.title} gave no summary of that operation, which is a bug in the plugin.`);
      await this.write(opened, this.guarded(() => host.serialize(applied.document)));
      opened.document = applied.document;
      const change = this.logged(opened, author, applied.summary, applied.touched ?? [], operation, applied.inverse);
      this.publisher.stateChanged(stateOf(opened));
      return publicChange(change);
    });
  }

  /** The document in the plugin's words, and the latest changes, for the agent. */
  describe(workspaceId: string, appName: string | undefined): string {
    const opened = this.openIn(workspaceId, appName);
    const heading = `${opened.plugin.manifest.title} on ${opened.file}`;
    if (opened.problem) return `${heading}\n\nThe file can't be read: ${opened.problem}`;
    const description = this.guarded(() => opened.plugin.host.describe(opened.document));
    const recent = opened.changes.slice(-CHANGES_DESCRIBED).map(({ seq, author, summary }) => `${seq}. ${authorWords(author)}: ${summary}`);
    return [heading, description, recent.length > 0 ? `Latest changes:\n${recent.join("\n")}` : "No changes yet since Mirador started."].join("\n\n");
  }

  forgetWorkspace(workspaceId: string) {
    const closed = [...this.documents.values()].filter((opened) => opened.workspaceId === workspaceId);
    for (const opened of closed) this.close(workspaceId, opened.plugin.manifest.name);
    if (closed.length > 0) this.publisher.openAppsChanged(this.openApps());
  }

  stop() {
    for (const opened of [...this.documents.values()]) this.close(opened.workspaceId, opened.plugin.manifest.name);
  }

  private plugin(name: string) {
    const plugin = this.plugins.find(({ manifest }) => manifest.name === name);
    if (!plugin) throw new AppProblem(`No app is called ${name}. Installed: ${this.plugins.map(({ manifest }) => manifest.name).join(", ") || "none"}.`);
    return plugin;
  }

  private openIn(workspaceId: string, appName: string | undefined): AppDocument {
    const here = [...this.documents.values()].filter((opened) => opened.workspaceId === workspaceId);
    const named = appName === undefined ? here : here.filter(({ plugin }) => plugin.manifest.name === appName);
    if (named.length === 1) return named[0]!;
    const names = (documents: AppDocument[]) => documents.map(({ plugin }) => plugin.manifest.name).join(", ");
    if (here.length === 0) throw new AppProblem(`No app is open in this workspace. Open one with app_open; installed: ${this.plugins.map(({ manifest }) => manifest.name).join(", ")}.`);
    if (appName !== undefined) throw new AppProblem(`${appName} isn't open in this workspace; open here: ${names(here)}.`);
    throw new AppProblem(`Several apps are open here (${names(here)}); say which with app.`);
  }

  private created(plugin: AppPlugin, file: string) {
    const { create } = plugin.host;
    if (!create) throw new AppProblem(`${file} doesn't exist, and ${plugin.manifest.title} can't start a new one; give the path of an existing file.`);
    return this.guarded(() => create.call(plugin.host));
  }

  /** Plugin code runs in the host's process: whatever it throws becomes a problem for whoever asked, and nothing changes. */
  private guarded<T>(call: () => T): T {
    try {
      return call();
    } catch (error) {
      throw error instanceof AppProblem ? error : new AppProblem(messageOf(error));
    }
  }

  private queued<T>(opened: AppDocument, run: () => Promise<T>): Promise<T> {
    const result = opened.queue.then(run);
    opened.queue = result.catch(() => {});
    return result;
  }

  private logged(opened: AppDocument, author: AppAuthor, summary: string, touched: string[], operation: unknown, inverse: unknown) {
    const change: LoggedChange = { seq: opened.changes.length + 1, author, summary, touched, at: Date.now(), operation, inverse };
    opened.changes.push(change);
    return change;
  }

  /** Written whole and renamed into place, so neither a reader nor the watcher ever sees half a file. */
  private async write(opened: AppDocument, text: string) {
    mkdirSync(dirname(opened.path), { recursive: true });
    const temporary = join(dirname(opened.path), `.${basename(opened.path)}.mirador-${process.pid}`);
    await Bun.write(temporary, text);
    renameSync(temporary, opened.path);
    opened.knownHash = hashOf(text);
  }

  private watch(opened: AppDocument) {
    const name = basename(opened.path);
    try {
      opened.watcher = watch(dirname(opened.path), (_event, changed) => {
        if (changed !== null && changed !== name) return;
        clearTimeout(opened.settling);
        opened.settling = setTimeout(() => void this.readOutsideEdit(opened), OUTSIDE_EDIT_SETTLE_MS);
      });
    } catch (error) {
      console.warn(`Can't watch ${opened.file} for edits made outside Mirador: ${messageOf(error)}`);
    }
  }

  private readOutsideEdit(opened: AppDocument) {
    return this.queued(opened, async () => {
      if (this.documents.get(appKey(openAppOf(opened))) !== opened || !existsSync(opened.path)) return;
      const text = readFileSync(opened.path, "utf8");
      const hash = hashOf(text);
      if (hash === opened.knownHash) return;
      opened.knownHash = hash;
      try {
        opened.document = opened.plugin.host.parse(text);
        opened.problem = null;
        this.logged(opened, { kind: "outside" }, "Edited outside Mirador", [], null, null);
      } catch (error) {
        opened.problem = messageOf(error);
      }
      this.publisher.stateChanged(stateOf(opened));
    });
  }

  private close(workspaceId: string, app: string) {
    const key = appKey({ workspaceId, app });
    const opened = this.documents.get(key);
    if (!opened) return;
    opened.watcher?.close();
    clearTimeout(opened.settling);
    this.documents.delete(key);
  }
}
