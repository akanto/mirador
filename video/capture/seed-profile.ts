/**
 * Run with bun before the trailer's host first starts: its only profile is "Claude Code", as a person's own would be
 * named, but its Claude Code talks to the director instead of Anthropic's API.
 * bun capture/seed-profile.ts <database path> <environment>
 */
import { join } from "node:path";

const [databasePath, environment] = process.argv.slice(2);
const { Store } = await import(join(import.meta.dirname, "..", "..", "host", "store.ts"));
const store = new Store(databasePath);
store.saveProfile({
  id: crypto.randomUUID(),
  name: "Claude Code",
  harness: "claude",
  environment,
  prelaunch: "",
  mode: null,
  bypassPermissions: false,
  askMode: "wait",
  createdAt: Date.now(),
});
store.close();
