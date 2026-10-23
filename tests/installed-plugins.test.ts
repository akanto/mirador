import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InstalledPlugins, withoutCredentials } from "../host/apps/installed-plugins.ts";
import { loadAppPlugins } from "../host/apps/plugins.ts";

const COUNTER = join(import.meta.dir, "fixtures", "apps", "counter");
const root = mkdtempSync(join(tmpdir(), "mirador-installed-plugins-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function git(folder: string, ...args: string[]) {
  const done = Bun.spawnSync(["git", "-C", folder, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { stderr: "pipe" });
  if (done.exitCode !== 0) throw new Error(done.stderr.toString());
  return done.stdout.toString().trim();
}

/** A repo holding the counter plugin, one commit on main. */
function counterRepo() {
  const repo = join(root, "counter-repo");
  cpSync(COUNTER, repo, { recursive: true });
  git(repo, "init", "--quiet", "-b", "main");
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "Count by one");
  return repo;
}

describe("withoutCredentials", () => {
  test("drops the user and token from a URL, wherever it is in the text", () => {
    expect(withoutCredentials("https://me:s3cret@github.com/me/counter.git")).toBe("https://github.com/me/counter.git");
    expect(withoutCredentials("fatal: could not read from 'https://ghp_abc@github.com/x.git' (403)")).toBe("fatal: could not read from 'https://github.com/x.git' (403)");
  });

  test("leaves a remote without credentials as it is", () => {
    expect(withoutCredentials("git@github.com:me/counter.git")).toBe("git@github.com:me/counter.git");
    expect(withoutCredentials("/Users/me/prj/counter")).toBe("/Users/me/prj/counter");
  });
});

describe("InstalledPlugins", () => {
  test("lists each plugin with where it came from, and why one didn't load", async () => {
    const plugins = join(root, "plugins");
    mkdirSync(plugins);
    const repo = counterRepo();
    git(plugins, "clone", "--quiet", repo, "cloned");
    git(join(plugins, "cloned"), "remote", "set-url", "origin", "https://me:s3cret@example.com/me/counter.git");
    const elsewhere = join(root, "elsewhere");
    cpSync(COUNTER, elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, "plugin.json"), JSON.stringify({ name: "linked-counter", title: "Linked counter", api: 1, app: { host: "host.ts", view: "view.js" } }));
    symlinkSync(elsewhere, join(plugins, "linked"));
    mkdirSync(join(plugins, "broken"));
    writeFileSync(join(plugins, "broken", "plugin.json"), JSON.stringify({ name: "broken", title: "Broken", api: 1, app: { host: "host.ts", view: "dist/view.js" } }));
    mkdirSync(join(plugins, "not-a-plugin"));

    const loaded = await loadAppPlugins(plugins);
    expect(loaded.plugins.map(({ manifest }) => manifest.name)).toEqual(["counter", "linked-counter"]);
    const listed = await new InstalledPlugins(plugins, loaded.problems).list();

    expect(listed).toEqual([
      { folder: "broken", name: "broken", title: "Broken", source: { kind: "folder" }, problem: "host.ts doesn't exist; build the plugin first?" },
      {
        folder: "cloned",
        name: "counter",
        title: "Counter",
        source: { kind: "git", remote: "https://example.com/me/counter.git", branch: "main", commit: git(repo, "rev-parse", "--short", "HEAD"), subject: "Count by one" },
        problem: null,
      },
      { folder: "linked", name: "linked-counter", title: "Linked counter", source: { kind: "linked", target: elsewhere }, problem: null },
    ]);
  });
});
