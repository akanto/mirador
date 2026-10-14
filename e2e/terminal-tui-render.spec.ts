import { expect, test } from "@playwright/test";
import { addWorkspace, signIn, startConversation } from "./helpers.ts";
import { TestHost } from "./test-host.ts";

const host = new TestHost();

test.beforeAll(() => host.start());
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
});

const tuiScript = String.raw`
draw() {
  set -- $(stty size); h=$1; w=$2
  i=1
  while [ $i -le $h ]; do printf '\033[%d;1H\033[KROW-%d-%d' $i $i $w; i=$((i+1)); done
  printf '\033[%d;1H\033[KSTATUS' $h
}
printf '\033[?1049h\033[2J'
prev=""
while :; do
  cur=$(stty size)
  [ "$cur" != "$prev" ] && { prev=$cur; draw; }
  sleep 0.2
done
`;

test("a full-screen program keeps painting every row after the terminal grows and shrinks", async ({ page }) => {
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  await startConversation(page);
  await page.getByRole("button", { name: "Show terminal" }).click();
  await page.locator(".terminal-pane .xterm-screen").click();

  const rows = page.locator(".terminal-pane .xterm-rows > div");
  const paintedEverywhere = async () => {
    const texts = await rows.evaluateAll((els) => els.map((el) => el.textContent ?? ""));
    const blank = texts
      .map((text, index) => [index, text] as const)
      .filter(([, text]) => !text.trim());
    return { rowCount: texts.length, blank };
  };

  await page.keyboard.type(`${tuiScript}\n`);
  await expect.poll(paintedEverywhere, { message: "the program paints every row to begin with" }).toEqual(
    expect.objectContaining({ blank: [] }),
  );
  const startRows = (await paintedEverywhere()).rowCount;

  const viewport = page.viewportSize()!;
  const resizeTo = async (height: number) => {
    await page.setViewportSize({ ...viewport, height });
    await expect.poll(paintedEverywhere, { message: `painting is complete at height ${height}` }).toEqual(
      expect.objectContaining({ blank: [] }),
    );
  };

  await resizeTo(viewport.height + 300);
  await resizeTo(viewport.height);
  expect((await paintedEverywhere()).rowCount).toBe(startRows);
  await resizeTo(viewport.height - 200);
  await resizeTo(viewport.height + 150);
});
