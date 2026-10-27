/**
 * Run with bun before the trailer's host first starts: its profiles are "Claude Code", as a person's own would be named,
 * and "Local", the local model it delegates to, but both talk to the director instead of a model.
 * bun capture/seed-profile.ts <database path> <environment>
 */
import { join } from "node:path";

const [databasePath, environment] = process.argv.slice(2);
const { Store } = await import(join(import.meta.dirname, "..", "..", "host", "store.ts"));
const store = new Store(databasePath);
for (const name of ["Claude Code", "Local"]) {
  store.saveProfile({
    id: crypto.randomUUID(),
    name,
    harness: "claude",
    environment,
    prelaunch: "",
    mode: null,
    bypassPermissions: false,
    askMode: "wait",
    createdAt: Date.now(),
  });
}
store.close();
