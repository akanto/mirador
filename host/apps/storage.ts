import { APP_STORAGE_CHARACTERS, storageCharacters, type AppStorageItems } from "../../shared/apps.ts";
import type { Store } from "../store.ts";
import { AppProblem } from "./plugins.ts";

/** What each app's view keeps in each workspace, as its localStorage, within the room localStorage would give it. */
export class AppStorage {
  constructor(
    private readonly store: Store,
    private readonly isInstalled: (app: string) => boolean,
  ) {}

  items(workspaceId: string, app: string): AppStorageItems {
    return this.store.appStorage(workspaceId, app);
  }

  /** Sets one item, or removes it for a null value, and gives the items as they are then; refuses a change that doesn't fit, changing nothing. */
  set(workspaceId: string, app: string, key: unknown, value: unknown): AppStorageItems {
    if (!this.isInstalled(app)) throw new AppProblem(`No app named ${app} is installed.`);
    if (typeof key !== "string" || (value !== null && typeof value !== "string")) throw new AppProblem(`${app}'s storage keeps text: its key and value must be strings.`);
    const items = new Map(Object.entries(this.items(workspaceId, app)));
    if (value === null) items.delete(key);
    else items.set(key, value);
    const next = Object.fromEntries(items);
    if (storageCharacters(next) > APP_STORAGE_CHARACTERS) {
      throw new AppProblem(`${app} can keep ${APP_STORAGE_CHARACTERS} characters in a workspace; ${key} doesn't fit.`);
    }
    this.store.saveAppStorageItem(workspaceId, app, key, value);
    return next;
  }
}
