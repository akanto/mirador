import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect, test } from "@playwright/test";
import { openSettings, signIn, startDesktopNotifier } from "./helpers.ts";
import { TestHost } from "./test-host.ts";

/** The fake GitHub's port is known only once it listens, which is before the host starts and reads this. */
const releaseEnvironment: Record<string, string> = { MIRADOR_NEWER_VERSION_CHECK: "on" };
const releaseHost = new TestHost(4722, { copiesSource: true, environment: releaseEnvironment });
const checkoutHost = new TestHost(4724, { copiesSource: true, environment: { MIRADOR_NEWER_VERSION_CHECK: "on" } });

const github = createServer((_, response) => {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ tag_name: "v99.0.0", html_url: "https://elsewhere.example/" }));
});

const git = (directory: string, ...args: string[]) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "user.name=e2e", "-c", "user.email=e2e@example.com", ...args], {
    cwd: directory,
    encoding: "utf8",
  });

/** The host's copied source becomes a checkout of a local origin, which then gets two commits the checkout lacks. */
function makeACheckoutTwoCommitsBehind(host: TestHost) {
  host.copySource();
  const origin = join(host.root, "origin.git");
  const elsewhere = join(host.root, "elsewhere");
  git(host.sourceDir, "init", "--quiet", "-b", "main");
  git(host.sourceDir, "add", "--all");
  git(host.sourceDir, "commit", "--quiet", "-m", "The source as copied");
  git(host.root, "init", "--quiet", "--bare", "-b", "main", origin);
  git(host.sourceDir, "remote", "add", "origin", origin);
  git(host.sourceDir, "push", "--quiet", "--set-upstream", "origin", "main");
  git(host.root, "clone", "--quiet", origin, elsewhere);
  writeFileSync(join(elsewhere, "web", "pulled.txt"), "pulled\n");
  git(elsewhere, "add", "--all");
  git(elsewhere, "commit", "--quiet", "-m", "A change to the UI");
  git(elsewhere, "commit", "--quiet", "--allow-empty", "-m", "Another change");
  git(elsewhere, "push", "--quiet");
}

test.beforeAll(async () => {
  await new Promise<void>((resolve) => github.listen(0, "127.0.0.1", resolve));
  releaseEnvironment.MIRADOR_LATEST_RELEASE_URL = `http://127.0.0.1:${(github.address() as AddressInfo).port}/repos/sodre90/mirador/releases/latest`;
  makeACheckoutTwoCommitsBehind(checkoutHost);
  await Promise.all([releaseHost.start(), checkoutHost.start()]);
});
test.afterAll(async () => {
  await Promise.all([releaseHost.stop(), checkoutHost.stop()]);
  await Promise.all([releaseHost.cleanUp(), checkoutHost.cleanUp()]);
  github.close();
});

async function desktopAppOf(host: TestHost) {
  const signedIn = await fetch(host.authUrl, { redirect: "manual" });
  const token = signedIn.headers.get("set-cookie")!.split(";")[0]!.split("=")[1]!;
  const app = startDesktopNotifier(host.origin, token);
  const lines = createInterface({ input: app.stdout! })[Symbol.asyncIterator]();
  const untilLine = async (text: string) => {
    for (;;) {
      if (String((await lines.next()).value) === text) return;
    }
  };
  return { app, untilLine };
}

test("a release shows a newer published release in a banner, in Settings › About and in the desktop app's menu, until the banner is dismissed", async ({ page }) => {
  await signIn(page, releaseHost);
  const banner = page.locator(".banner.newer-version");
  await expect(banner).toContainText("Mirador 99.0.0 is out.");
  await expect(banner.getByRole("link", { name: "Download" })).toHaveAttribute("href", "https://github.com/sodre90/mirador/releases/tag/v99.0.0");

  const { app, untilLine } = await desktopAppOf(releaseHost);
  try {
    await untilLine("newer: Mirador 99.0.0 is out");
  } finally {
    app.kill();
  }

  await banner.getByRole("button", { name: "Dismiss" }).click();
  await expect(banner).toHaveCount(0);
  await page.reload();
  const about = await openSettings(page, "About");
  await expect(about.locator(".newer-version")).toHaveText("Mirador 99.0.0 is out. Download");
  await page.keyboard.press("Escape");
  await expect(banner).toHaveCount(0);
});

test("a checkout shows the commits on its upstream that it lacks, until they are pulled", async ({ page }) => {
  await signIn(page, checkoutHost);
  const banner = page.locator(".banner.newer-version");
  await expect(banner).toContainText("2 new commits on origin/main.");
  await expect(banner).toContainText("Pull them to update.");

  git(checkoutHost.sourceDir, "merge", "--quiet", "--ff-only", "origin/main");
  await expect(banner).toHaveCount(0);
});

test("the desktop window shows when an update is ready and offers to restart into it, until dismissed", async ({ page }) => {
  await signIn(page, releaseHost);
  const banner = page.locator(".banner.newer-version");
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("mirador:desktop-update", { detail: { version: "99.0.0" } }));
  });
  await expect(banner).toContainText("Mirador 99.0.0 is ready.");
  const restartButton = banner.getByRole("button", { name: "Restart to update" });
  await expect(restartButton).toBeVisible();

  await page.evaluate(() => {
    window.__electrobunSendToHost = (message) => {
      (window as unknown as { lastSent: unknown }).lastSent = message;
    };
    window.dispatchEvent(new CustomEvent("mirador:desktop-nonce", { detail: "test-nonce" }));
  });
  await restartButton.click();
  const sent = await page.evaluate(() => (window as unknown as { lastSent: { type: string; nonce: string; action: string } }).lastSent);
  expect(sent).toEqual({ type: "desktop-action", nonce: "test-nonce", action: "install-update" });

  await banner.getByRole("button", { name: "Dismiss" }).click();
  await expect(banner).toHaveCount(0);
  const about = await openSettings(page, "About");
  await expect(about.locator(".newer-version")).toContainText("Mirador 99.0.0 is ready.");
  await expect(about.locator(".newer-version").getByRole("button", { name: "Restart to update" })).toBeVisible();
  await page.keyboard.press("Escape");
});
