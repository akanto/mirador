import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InstalledPlugins, withoutCredentials } from "../host/apps/installed-plugins.ts";
import { loadPlugins } from "../host/apps/plugins.ts";

const COUNTER = join(import.meta.dir, "fixtures", "apps", "counter");
/** The counter's view as git stores it: a checkout with core.autocrlf, as on the Windows runner, gives it CRLF. */
const counterViewAsCommitted = () => readFileSync(join(COUNTER, "view.js"), "utf8").replaceAll("\r\n", "\n");
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
    writeFileSync(join(elsewhere, "plugin.json"), JSON.stringify({ name: "linked-counter", title: "Linked counter", version: "1.0.0", api: 1, app: { host: "host.ts", view: "view.js" } }));
    symlinkSync(elsewhere, join(plugins, "linked"));
    mkdirSync(join(plugins, "broken"));
    writeFileSync(join(plugins, "broken", "plugin.json"), JSON.stringify({ name: "broken", title: "Broken", version: "1.0.0", api: 1, app: { host: "host.ts", view: "dist/view.js" } }));
    mkdirSync(join(plugins, "not-a-plugin"));

    const loaded = await loadPlugins(plugins);
    expect(loaded.apps.map(({ manifest }) => manifest.name)).toEqual(["counter", "linked-counter"]);
    const listed = await new InstalledPlugins(plugins, loaded.problems).list();

    expect(listed).toEqual([
      { folder: "broken", name: "broken", title: "Broken", version: "1.0.0", source: { kind: "folder" }, problem: "host.ts doesn't exist; build the plugin first?", waitsForRestart: false },
      {
        folder: "cloned",
        name: "counter",
        title: "Counter",
        version: "1.0.0",
        source: { kind: "git", remote: "https://example.com/me/counter.git", branch: "main", release: null, commit: git(repo, "rev-parse", "--short", "HEAD"), subject: "Count by one" },
        problem: null,
        waitsForRestart: false,
      },
      { folder: "linked", name: "linked-counter", title: "Linked counter", version: "1.0.0", source: { kind: "linked", target: elsewhere }, problem: null, waitsForRestart: false },
    ]);
  });

});

describe("adding, updating and removing plugins", () => {
  /** A repo of the counter plugin whose view only exists once its build ran, as with a bundled view. */
  function builtCounterRepo(name: string) {
    const repo = join(root, name);
    cpSync(COUNTER, repo, { recursive: true });
    mkdirSync(join(repo, "src"));
    cpSync(join(COUNTER, "view.js"), join(repo, "src", "view.js"));
    rmSync(join(repo, "view.js"));
    writeFileSync(join(repo, ".gitignore"), "/view.js\n");
    writeFileSync(join(repo, "build.ts"), 'await Bun.write("view.js", Bun.file("src/view.js"));\n');
    writeFileSync(join(repo, "plugin.json"), JSON.stringify({ name: "counter", title: "Counter", version: "1.0.0", api: 1, app: { host: "host.ts", view: "view.js" }, build: "bun build.ts" }));
    git(repo, "init", "--quiet", "-b", "main");
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "Count by one");
    return repo;
  }

  function commit(repo: string, file: string, content: string, message: string) {
    writeFileSync(join(repo, file), content);
    git(repo, "commit", "--quiet", "-am", message);
  }

  const pluginsIn = (name: string) => {
    const folder = join(root, name, "plugins");
    mkdirSync(folder, { recursive: true });
    return folder;
  };
  const leftInStaging = (plugins: string) => (existsSync(`${plugins}-staging`) ? readdirSync(`${plugins}-staging`) : []);

  test("clones the repo, runs its build, and puts it in a folder named as the plugin, which loads at the next start", async () => {
    const repo = builtCounterRepo("add-repo");
    const plugins = pluginsIn("add");
    const installed = new InstalledPlugins(plugins, []);
    await installed.add(` ${repo} `, "main");

    expect(readFileSync(join(plugins, "counter", "view.js"), "utf8")).toBe(counterViewAsCommitted());
    expect(installed.restartNeeded).toBe(true);
    expect(await installed.list()).toEqual([
      {
        folder: "counter",
        name: "counter",
        title: "Counter",
        version: "1.0.0",
        source: { kind: "git", remote: repo, branch: "main", release: null, commit: git(repo, "rev-parse", "--short", "HEAD"), subject: "Count by one" },
        problem: null,
        waitsForRestart: true,
      },
    ]);
    expect(leftInStaging(plugins)).toEqual([]);
    expect((await loadPlugins(plugins)).apps.map(({ manifest }) => manifest.name)).toEqual(["counter"]);
  });

  test("refuses a repo whose build fails, with the end of its output, and leaves nothing behind", async () => {
    const repo = builtCounterRepo("failing-build-repo");
    commit(repo, "build.ts", 'console.error("the bundler choked"); process.exit(3);\n', "Break the build");
    const plugins = pluginsIn("failing-build");
    const installed = new InstalledPlugins(plugins, []);

    await expect(installed.add(repo, null)).rejects.toThrow("Its build command, bun build.ts, failed:\nthe bundler choked");
    expect(readdirSync(plugins)).toEqual([]);
    expect(leftInStaging(plugins)).toEqual([]);
    expect(installed.restartNeeded).toBe(false);
  });

  test("refuses a repo without a plugin.json, a plugin whose name is taken, and a remote it can't reach, without showing its credentials", async () => {
    const plugins = pluginsIn("refusals");
    const installed = new InstalledPlugins(plugins, []);
    const notAPlugin = join(root, "not-a-plugin-repo");
    mkdirSync(notAPlugin);
    writeFileSync(join(notAPlugin, "README.md"), "Hello\n");
    git(notAPlugin, "init", "--quiet", "-b", "main");
    git(notAPlugin, "add", ".");
    git(notAPlugin, "commit", "--quiet", "-m", "Hello");
    await expect(installed.add(notAPlugin, null)).rejects.toThrow("The repo isn't a plugin Mirador can load: there's no plugin.json at the top of its folder.");

    cpSync(COUNTER, join(plugins, "my-counter"), { recursive: true });
    await expect(installed.add(builtCounterRepo("taken-repo"), null)).rejects.toThrow("The plugin in my-counter is already named counter; remove it first.");

    const unreachable = installed.add("https://me:s3cret@127.0.0.1:9/counter.git", null);
    await expect(unreachable).rejects.toThrow("git ls-remote failed:");
    await expect(unreachable).rejects.not.toThrow("s3cret");
    expect(leftInStaging(plugins)).toEqual([]);
  });

  test("an update lists the new commits, then swaps in the new build; a failed one leaves the plugin as it was", async () => {
    const repo = builtCounterRepo("update-repo");
    const plugins = pluginsIn("update");
    await new InstalledPlugins(plugins, []).add(repo, null);
    const installed = new InstalledPlugins(plugins, []);
    expect(await installed.news("counter")).toEqual({ release: null, commits: [] });

    commit(repo, "src/view.js", "document.body.textContent = 'Counting by two';\n", "Count by two");
    const [newest] = (await installed.news("counter")).commits;
    expect(newest).toEqual({ commit: git(repo, "rev-parse", "--short", "HEAD"), subject: "Count by two" });
    await installed.update("counter");
    expect(readFileSync(join(plugins, "counter", "view.js"), "utf8")).toBe("document.body.textContent = 'Counting by two';\n");
    expect((await installed.list())[0]).toMatchObject({ source: { commit: newest!.commit, subject: "Count by two" }, waitsForRestart: true });

    commit(repo, "build.ts", "process.exit(1);\n", "Break the build");
    await expect(installed.update("counter")).rejects.toThrow("Its build command, bun build.ts, failed:");
    expect(readFileSync(join(plugins, "counter", "view.js"), "utf8")).toBe("document.body.textContent = 'Counting by two';\n");
    expect(git(join(plugins, "counter"), "log", "-1", "--format=%s")).toBe("Count by two");
  });

  test("the updates found by itself name each git plugin with new commits and its commit then; offline, a plugin keeps what was found last", async () => {
    const repo = builtCounterRepo("updates-found-repo");
    const plugins = pluginsIn("updates-found");
    const installed = new InstalledPlugins(plugins, []);
    await installed.add(repo, null);
    expect(await installed.updatesFound(null)).toEqual([]);

    commit(repo, "src/view.js", "document.body.textContent = 'Counting by two';\n", "Count by two");
    const installedAt = git(join(plugins, "counter"), "rev-parse", "--short", "HEAD");
    const found = await installed.updatesFound(null);
    expect(found).toEqual([{ folder: "counter", title: "Counter", from: installedAt, release: null, commits: [{ commit: git(repo, "rev-parse", "--short", "HEAD"), subject: "Count by two" }] }]);

    rmSync(repo, { recursive: true, force: true });
    expect(await installed.updatesFound(found)).toEqual(found);
    expect(await installed.updatesFound(null)).toEqual([]);
  });

  /** Commits plugin.json at the version and tags the commit as `tag`, its release tag by default. */
  function release(repo: string, version: string, tag = `v${version}`) {
    const manifest = join(repo, "plugin.json");
    writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, "utf8")), version }));
    git(repo, "commit", "--quiet", "-am", `Release ${version}`);
    git(repo, "tag", tag);
  }

  test("without a branch, installs the newest release and follows the releases, not the branch", async () => {
    const repo = builtCounterRepo("release-repo");
    git(repo, "tag", "v1.0.0");
    release(repo, "1.9.0");
    release(repo, "1.10.0");
    git(repo, "tag", "v2.0.0-rc1");
    const plugins = pluginsIn("release");
    const installed = new InstalledPlugins(plugins, []);
    await installed.add(repo, null);

    const [listed] = await installed.list();
    expect(listed).toMatchObject({ version: "1.10.0", source: { kind: "git", branch: null, release: "1.10.0", subject: "Release 1.10.0" } });
    expect(await installed.news("counter")).toEqual({ release: null, commits: [] });

    commit(repo, "src/view.js", "document.body.textContent = 'Counting by two';\n", "Count by two");
    release(repo, "1.11.0");
    const news = { release: "1.11.0", commits: [{ commit: git(repo, "rev-parse", "--short", "HEAD"), subject: "Release 1.11.0" }, { commit: git(repo, "rev-parse", "--short", "HEAD~1"), subject: "Count by two" }] };
    expect(await installed.news("counter")).toEqual(news);
    expect(await installed.updatesFound(null)).toEqual([{ folder: "counter", title: "Counter", from: listed!.source.kind === "git" ? listed!.source.commit : "", ...news }]);

    await installed.update("counter");
    expect((await installed.list())[0]).toMatchObject({ version: "1.11.0", source: { release: "1.11.0" }, waitsForRestart: true });
    expect(readFileSync(join(plugins, "counter", "view.js"), "utf8")).toBe("document.body.textContent = 'Counting by two';\n");
  });

  test("refuses a release whose plugin.json gives another version, and a plugin without a version, which doesn't load either", async () => {
    const repo = builtCounterRepo("mistagged-repo");
    release(repo, "1.2.0", "v1.3.0");
    const plugins = pluginsIn("mistagged");
    const installed = new InstalledPlugins(plugins, []);
    await expect(installed.add(repo, null)).rejects.toThrow("Its tag v1.3.0 is release 1.3.0, but its plugin.json says version 1.2.0.");

    const manifest = join(repo, "plugin.json");
    const { version: _, ...unversioned } = JSON.parse(readFileSync(manifest, "utf8"));
    writeFileSync(manifest, JSON.stringify(unversioned));
    git(repo, "commit", "--quiet", "-am", "Forget the version");
    await expect(installed.add(repo, "main")).rejects.toThrow("The repo isn't a plugin Mirador can load: plugin.json needs a version, its release as x.y.z, such as 1.0.0.");
    expect(leftInStaging(plugins)).toEqual([]);

    cpSync(COUNTER, join(plugins, "copied"), { recursive: true });
    writeFileSync(join(plugins, "copied", "plugin.json"), JSON.stringify(unversioned));
    expect((await loadPlugins(plugins)).problems).toEqual([{ folder: join(plugins, "copied"), message: "plugin.json needs a version, its release as x.y.z, such as 1.0.0" }]);
  });

  test("a plugin's files install as committed where the user's git checks text out with CRLF, as Git for Windows does", async () => {
    const repo = builtCounterRepo("crlf-repo");
    const plugins = pluginsIn("crlf");
    const crlfConfig = join(root, "crlf.gitconfig");
    writeFileSync(crlfConfig, "[core]\n\tautocrlf = true\n");
    const usersConfig = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = crlfConfig;
    try {
      await new InstalledPlugins(plugins, []).add(repo, null);
    } finally {
      if (usersConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = usersConfig;
    }

    expect(readFileSync(join(plugins, "counter", "view.js"), "utf8")).toBe(counterViewAsCommitted());
  });

  test("only a plugin cloned from a git repo has updates", async () => {
    const plugins = pluginsIn("no-updates");
    cpSync(COUNTER, join(plugins, "copied"), { recursive: true });
    const installed = new InstalledPlugins(plugins, []);
    await expect(installed.news("copied")).rejects.toThrow("copied wasn't installed from a git repo, so there's nothing to update it from.");
    await expect(installed.update("elsewhere")).rejects.toThrow("No plugin is installed in elsewhere.");
  });

  test("removing a linked plugin removes the link and keeps its folder; removing a cloned one takes it out of the plugins folder", async () => {
    const plugins = pluginsIn("remove");
    const linkedFolder = join(root, "remove-linked-target");
    cpSync(COUNTER, linkedFolder, { recursive: true });
    writeFileSync(join(linkedFolder, "plugin.json"), JSON.stringify({ name: "linked-counter", title: "Linked counter", version: "1.0.0", api: 1, app: { host: "host.ts", view: "view.js" } }));
    symlinkSync(linkedFolder, join(plugins, "linked"));
    const installed = new InstalledPlugins(plugins, []);
    await installed.add(builtCounterRepo("remove-repo"), null);

    expect(await installed.remove("counter")).toBe("counter");
    expect(await installed.remove("linked")).toBe("linked-counter");
    expect(readdirSync(plugins)).toEqual([]);
    expect(existsSync(join(linkedFolder, "plugin.json"))).toBe(true);
    expect(leftInStaging(plugins)).toHaveLength(1);
    new InstalledPlugins(plugins, []);
    expect(leftInStaging(plugins)).toEqual([]);
  });
});
