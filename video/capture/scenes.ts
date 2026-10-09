import { join } from "node:path";
import type { Script } from "./director.ts";

/** What the user types in each filmed conversation; the director's scripts answer to these. */
export const prompts = {
  explainCheckout: "Walk me through checkout, end to end. Where can an order get stuck?",
  settingsLayout: "Settings is getting long. Propose a few layouts and let me pick.",
  translate: "Translate the checkout pages to German and French.",
  runbook: "Draft the runbook for the Postgres 18 switch-over.",
  review: "Review the retry-payments branch against main.",
  questionAboutBlocker: "Is the cart id enough if the customer changes the cart?",
  fix: "Fix the blocker from the review: a retried capture must not charge the card twice.",
};

export const LAYOUT_CHOICE = "Grouped list (recommended)";

const checkoutDiagram = (assetsOrigin: string) => `<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 22px 26px; background: light-dark(#fbfaff, #17161f); color: light-dark(#1f1d2b, #ecebf5); }
  h1 { font-size: 21px; margin: 0 0 4px; }
  .lead { color: light-dark(#5d5a70, #a9a6bd); margin: 0 0 14px; }
  .diagram { background: light-dark(#fff, #1f1e2a); border: 1px solid light-dark(#e6e3f2, #34324a); border-radius: 12px; padding: 10px; }
  .risks { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 14px; }
  .risk { background: light-dark(#fff, #1f1e2a); border: 1px solid light-dark(#e6e3f2, #34324a); border-left: 4px solid #e5484d; border-radius: 10px; padding: 9px 12px; font-size: 13px; }
  .risk.slow { border-left-color: #f5a524; }
  .risk b { display: block; }
</style>
<h1>Checkout, end to end</h1>
<p class="lead">One request, four services, in the order they run. ⚠ marks where an order can get stuck.</p>
<div class="diagram"><pre class="mermaid">
sequenceDiagram
  autonumber
  participant B as Browser
  participant A as Checkout API
  participant I as Inventory
  participant P as Payments
  participant O as Orders
  B->>A: POST /checkout
  A->>I: reserve(cart.items)
  I-->>A: reservation
  A->>P: capture(card, total)
  Note over A,P: ⚠ no idempotency key
  P-->>A: payment
  A->>O: create(cart, payment)
  O-->>A: order 1042
  A->>A: ⚠ send the email in the request
  A-->>B: 201 Created
</pre></div>
<div class="risks">
  <div class="risk"><b>Declined card</b>Stock stays reserved until the nightly job.</div>
  <div class="risk"><b>Retried capture</b>Without a key, the card is charged twice.</div>
  <div class="risk slow"><b>Slow mail server</b>Holds the order open while it sends.</div>
</div>
<script src="${assetsOrigin}/mermaid.min.js"></script>
<script>
  const dark = getComputedStyle(document.documentElement).colorScheme === "dark" || matchMedia("(prefers-color-scheme: dark)").matches;
  mermaid.initialize({ startOnLoad: true, theme: dark ? "dark" : "neutral", sequence: { mirrorActors: false, showSequenceNumbers: true } });
</script>`;

/** A phone showing a settings screen; the phone stays light, as the app it previews does. */
const phoneMockup = (body: string) => `<style>
  body { margin: 0; padding: 10px; background: transparent; font: 11px -apple-system, system-ui, sans-serif; color: #1f1d2b; }
  .phone { width: 190px; height: 300px; margin: 0 auto; border: 6px solid #2a2838; border-radius: 22px; background: #fff; overflow: hidden; padding: 12px 10px; box-sizing: border-box; box-shadow: 0 6px 18px rgba(0,0,0,.25); }
  .title { font-weight: 700; font-size: 14px; margin-bottom: 8px; }
  .section { color: #8a86a0; font-size: 9px; letter-spacing: 0.06em; text-transform: uppercase; margin: 8px 0 4px; }
  .row { display: flex; justify-content: space-between; align-items: center; padding: 5px 0; border-bottom: 1px solid #eeecf5; }
  .toggle { width: 22px; height: 12px; border-radius: 6px; background: #6e56cf; }
  .toggle.off { background: #d6d3e3; }
  .tabs { display: flex; gap: 4px; margin-bottom: 8px; }
  .tab { padding: 3px 6px; border-radius: 6px; background: #eeecf5; }
  .tab.on { background: #6e56cf; color: #fff; }
  .search { border: 1px solid #d6d3e3; border-radius: 8px; padding: 6px 8px; color: #8a86a0; margin-bottom: 8px; }
</style><div class="phone">${body}</div>`;

const rows = (...names: string[]) => names.map((name, index) => `<div class="row">${name}<span class="toggle${index % 3 === 1 ? " off" : ""}"></span></div>`).join("");

const settingsQuestion = {
  question: "Which layout should the settings screen use?",
  html: `<div style="font: 14px -apple-system, system-ui, sans-serif; color: light-dark(#1f1d2b, #ecebf5); color-scheme: light dark"><b>Settings today:</b> 27 rows on one page, in the order they were added. People scroll past what they need, and three support tickets this month asked where the theme setting went.</div>`,
  options: [
    {
      label: LAYOUT_CHOICE,
      description: "One page with section headers. Easiest to scan, and nothing hides behind a tap.",
      html: phoneMockup(`<div class="title">Settings</div><div class="section">Appearance</div>${rows("Theme", "Large text")}<div class="section">Notifications</div>${rows("Questions", "Finished turns", "Errors")}<div class="section">Privacy</div>${rows("App lock")}`),
    },
    {
      label: "Tabs per area",
      description: "Shorter pages, but each setting is one tap further away.",
      html: phoneMockup(`<div class="title">Settings</div><div class="tabs"><span class="tab on">Look</span><span class="tab">Alerts</span><span class="tab">Privacy</span></div>${rows("Theme", "Large text", "Accent colour", "Compact rows")}`),
    },
    {
      label: "Search first",
      description: "Fast when you know the name; browsing gets harder.",
      html: phoneMockup(`<div class="title">Settings</div><div class="search">Search settings</div><div class="section">Most used</div>${rows("Theme", "Questions", "App lock")}<div class="section">&nbsp;</div><div class="row" style="color:#6e56cf">All settings ›</div>`),
    },
  ],
};

const review = (shopApi: string) => ({
  title: "Retry failed card payments",
  repository: shopApi,
  base: "main",
  verdict: "Request changes: a retried capture can charge the card twice.",
  summary: [
    "The branch retries a failed card capture up to three times, and releases the reserved stock when checkout fails.",
    "",
    "- **Good:** a declined card no longer keeps the stock reserved until the nightly job.",
    "- **Blocker:** the capture carries no idempotency key, so a timed-out capture that the bank accepted is charged again on retry.",
    "",
    "| Change | Where |",
    "| --- | --- |",
    "| Retry around the capture | `src/checkout.ts`, line 8 |",
    "| Release the stock on failure | `src/checkout.ts`, lines 12-14 |",
    "| New `withRetries` helper | `src/retry.ts` |",
  ].join("\n"),
  flow: [
    { title: "Checkout reserves the stock", at: "src/checkout.ts:5-6", say: "As before, the cart's items are reserved first, so nobody else can buy them mid-checkout." },
    { title: "The capture is retried", at: "src/checkout.ts:8", say: "The capture now runs through `withRetries`, up to three attempts." },
    { title: "Backoff between attempts", at: "src/retry.ts:1-10", say: "Waits 200 ms, then 400 ms, and rethrows the last error once the attempts run out." },
    { title: "The stock is released on failure", at: "src/checkout.ts:12-14", say: "Any failure releases the reservation, then rethrows, so the caller still sees the error." },
  ],
  findings: [
    {
      severity: "blocker",
      checked: "confirmed",
      at: "src/checkout.ts:8",
      title: "A retry can charge the card twice",
      body: "`payments.capture` gets no idempotency key. When the first attempt times out after the bank accepted it, the retry charges the card again. Pass `{ idempotencyKey: cart.id }`; the payments client forwards it as the `Idempotency-Key` header.",
      evidence: "Read the payments client: `capture(card, amount, options)` sends `options.idempotencyKey` as the header, and the bank deduplicates on it for 24 hours.",
    },
    {
      severity: "issue",
      checked: "plausible",
      at: "src/checkout.ts:13",
      title: "A failing release hides the payment error",
      body: "If `inventory.release` throws, the original payment error is lost. Catch the release error, log it, and rethrow the payment error.",
    },
    { severity: "nit", checked: "confirmed", at: "src/retry.ts:7", title: "Name the base delay", body: "`100` reads as a magic number; `BASE_DELAY_MS` says what it is." },
  ],
});

/** The director's scripts, for the projects of the demo world. */
export function scripts({ projects, assetsOrigin }: { projects: { shopApi: string; storefront: string; infra: string }; assetsOrigin: string }): Script[] {
  const { shopApi, infra } = projects;
  return [
    {
      prompt: prompts.explainCheckout,
      steps: [
        { thinkMs: 1100, say: "I'll trace the request through the code first.", call: { tool: "Read", input: { file_path: join(shopApi, "src/checkout.ts") } } },
        { thinkMs: 700, call: { tool: "Bash", input: { command: 'grep -rn "reserve\\|capture\\|release" src', description: "Find where stock and payments are handled" } } },
        {
          thinkMs: 900,
          say: "Checkout touches four services in one request. I drew the whole path on the canvas, with the three places an order can get stuck.",
          call: { tool: "canvas.show", input: { title: "Checkout, end to end", html: checkoutDiagram(assetsOrigin) } },
        },
        {
          thinkMs: 600,
          say: [
            "**Where an order can get stuck**",
            "",
            "1. **Stock is reserved before the payment.** A declined card leaves it reserved until the nightly job.",
            "2. **The capture has no idempotency key.** A retried request can charge the card twice.",
            "3. **The confirmation email is sent inside the request.** A slow mail server holds the order open.",
            "",
            "Want me to fix the first two? Both are small and covered by `checkout.test.ts`.",
          ].join("\n"),
        },
      ],
    },
    {
      prompt: prompts.settingsLayout,
      steps: [
        { thinkMs: 7500, say: "Three layouts on the canvas, each with a preview. Pick one and I'll build it.", call: { tool: "canvas.ask", input: settingsQuestion } },
        { thinkMs: 800, say: "Grouped list it is. I'll split the 27 rows into Appearance, Notifications and Privacy, with the theme at the top where people look for it." },
      ],
    },
    {
      prompt: prompts.translate,
      steps: [
        { thinkMs: 2200, say: "I'll start with the strings on each page.", call: { tool: "Bash", input: { command: "ls pages", description: "List the checkout pages" } } },
        { thinkMs: 3200, call: { tool: "Bash", input: { command: 'grep -rn "Checkout" pages', description: "Find the strings to translate" } } },
        { thinkMs: 2600, say: "Both translations are in, with each country's currency format." },
      ],
    },
    {
      prompt: prompts.runbook,
      steps: [
        { thinkMs: 3800, say: "Reading the cluster setup first.", call: { tool: "Read", input: { file_path: join(infra, "postgres/cluster.tf") } } },
        { thinkMs: 5200, say: "The runbook is ready: replicate to a new 18 cluster, switch over in the maintenance window, and keep 16 as the fallback for a day." },
      ],
    },
    {
      prompt: prompts.review,
      steps: [
        { thinkMs: 900, say: "Reading the branch's changes against main.", call: { tool: "Bash", input: { command: "git diff --stat main", description: "See what the branch changes" } } },
        { thinkMs: 1000, call: { tool: "canvas.review", input: review(shopApi) } },
        { thinkMs: 500, say: "The review is on the canvas: one blocker, one issue and a nit. Start with the flow tour, it is four steps." },
      ],
    },
    {
      prompt: prompts.questionAboutBlocker,
      steps: [
        {
          thinkMs: 1300,
          say: "No. The cart id stays the same when the customer changes the cart, so the bank would take the new total for a retry and drop it. I reworded the blocker to key on the id and the total.",
          call: {
            tool: "canvas.update_review",
            input: {
              findings: [
                {
                  id: "finding-1",
                  body: "`payments.capture` gets no idempotency key, so a retry after a timeout charges the card again. Pass `{ idempotencyKey: cartKey(cart) }`, built from the cart's id **and its total**: a retry reuses the key, but a changed cart gets a new one.",
                },
              ],
            },
          },
        },
        { thinkMs: 400, say: "Updated: the blocker now keys the capture on the cart's id and total." },
      ],
    },
    {
      prompt: prompts.fix,
      steps: [
        { thinkMs: 900, say: "The capture needs an idempotency key, so the bank can tell a retry from a new charge.", call: { tool: "Read", input: { file_path: join(shopApi, "src/checkout.ts") } } },
        {
          thinkMs: 700,
          call: { tool: "Edit", input: { file_path: join(shopApi, "src/checkout.ts"), old_string: "payments.capture(card, cart.total)", new_string: "payments.capture(card, cart.total, { idempotencyKey: cart.id })" } },
        },
        { thinkMs: 500, say: "Done: the capture sends the cart's id as its idempotency key, so a retry the bank already took no longer charges the card twice." },
      ],
    },
  ];
}
