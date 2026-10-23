import { statSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";

type EditListener = "uiEdited" | "hostEdited";

/** The page bundle is built from web/ and shared/; the host process runs host/ and shared/. */
const listenersByDirectory: Record<string, EditListener[]> = { web: ["uiEdited"], shared: ["uiEdited", "hostEdited"], host: ["hostEdited"] };

/** Windows tells of a folder whenever Bun loads a module from it; an edit tells of the file. */
const isFolder = (path: string) => statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;

/** Linux leaves the name out when the watched folder itself is replaced, as a deploy can do, which is an edit too. */
export const isEdit = (directory: string, name: string | null | undefined) => !name || !isFolder(join(directory, name));

/** Watches Mirador's own source, so a page reload gets fresh UI code and the page can tell that the host runs old code. */
export class SourceWatcher {
  private watchers: FSWatcher[] = [];

  constructor(
    private readonly sourceDir: string,
    private readonly on: Record<EditListener, () => void>,
  ) {}

  start() {
    this.watchers = Object.entries(listenersByDirectory).map(([directory, listeners]) =>
      watch(join(this.sourceDir, directory), { recursive: true }, (_event, name) => {
        if (isEdit(join(this.sourceDir, directory), name)) listeners.forEach((listener) => this.on[listener]());
      }),
    );
  }

  stop() {
    this.watchers.forEach((watcher) => watcher.close());
  }
}
