import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitHubCliProblemOn } from "../host/review/github.ts";

const root = mkdtempSync(join(tmpdir(), "mirador-gh-"));
const withGh = join(root, "with-gh");
const withoutGh = join(root, "without-gh");
mkdirSync(withGh);
mkdirSync(withoutGh);
writeFileSync(join(withGh, "gh"), `#!/bin/sh\n[ "$*" = "auth status --hostname ghe.example.com" ] && exit 0\nexit 1\n`);
chmodSync(join(withGh, "gh"), 0o755);

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("gitHubCliProblemOn", () => {
  test("finds no problem when gh is logged in to the pull request's host", async () => {
    expect(await gitHubCliProblemOn("ghe.example.com", withGh)).toBeNull();
  });

  test("says gh is logged out when it has no account it can use on that host", async () => {
    expect(await gitHubCliProblemOn("github.com", withGh)).toBe("logged-out");
  });

  test("says gh is missing when it is nowhere on the search path", async () => {
    expect(await gitHubCliProblemOn("ghe.example.com", withoutGh)).toBe("missing");
  });
});
