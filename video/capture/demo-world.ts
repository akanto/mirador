import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The trailer's world: a developer's home with a few projects under ~/code, each a git repository with a history, so
 * the sidebar reads `~/code` instead of a temporary folder, and Claude Code's settings are this home's, never the
 * settings of the person filming.
 */
export function worldIn(root: string) {
  const home = join(root, "home", "ada");
  const code = join(home, "code");
  return { home, projects: { shopApi: join(code, "shop-api"), mobileApp: join(code, "mobile-app"), storefront: join(code, "storefront"), infra: join(code, "infra") } };
}

/** Writes the world's files; Playwright also imports specs in a process that never runs their hooks, so call it from one. */
export function createWorld({ home, projects }: ReturnType<typeof worldIn>) {
  writeFiles(home, {
    ".zshrc": "PROMPT='%F{141}%1~%f %F{245}❯%f '\nPROMPT_EOL_MARK=''\nunsetopt BEEP\n",
    ".claude/settings.json": JSON.stringify({ permissions: { allow: ["Bash"] } }, null, 2),
    ".gitconfig": "[user]\n\tname = Ada\n\temail = ada@example.com\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n",
  });
  createShopApi(projects.shopApi);
  createProject(projects.mobileApp, { "README.md": "# mobile-app\n", "src/settings/SettingsScreen.tsx": settingsScreen }, "Settings screen with every option on one page");
  createProject(projects.storefront, { "README.md": "# storefront\n", "pages/checkout.tsx": "export default function Checkout() {\n  return <main>Checkout</main>;\n}\n" }, "Checkout page");
  createProject(projects.infra, { "README.md": "# infra\n", "postgres/cluster.tf": 'resource "postgres_cluster" "main" {\n  version = "16"\n}\n' }, "Postgres 16 cluster");
}

function writeFiles(directory: string, files: Record<string, string>) {
  Object.entries(files).forEach(([path, text]) => {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), text);
  });
}

export function git(directory: string, ...args: string[]) {
  execFileSync("git", ["-C", directory, "-c", "user.name=Ada", "-c", "user.email=ada@example.com", "-c", "commit.gpgsign=false", ...args]);
}

function createProject(directory: string, files: Record<string, string>, message: string) {
  writeFiles(directory, files);
  git(directory, "init", "-q", "-b", "main");
  git(directory, "add", ".");
  git(directory, "commit", "-q", "-m", message);
}

/** shop-api on a branch that retries card payments: the change the trailer's review is about. */
function createShopApi(directory: string) {
  createProject(directory, { "README.md": "# shop-api\n", "src/checkout.ts": checkoutBefore, "src/services.ts": services, "src/types.ts": types }, "Checkout reserves stock, captures the payment and creates the order");
  git(directory, "checkout", "-q", "-b", "retry-payments");
  writeFiles(directory, { "src/checkout.ts": checkoutAfter, "src/retry.ts": retry });
  git(directory, "add", ".");
  git(directory, "commit", "-q", "-m", "Retry failed card payments and release the stock");
}

export const checkoutBefore = `import { inventory, mail, orders, payments } from "./services";
import type { Card, Cart } from "./types";

export async function checkout(cart: Cart, card: Card) {
  const reservation = await inventory.reserve(cart.items);
  const payment = await payments.capture(card, cart.total);
  const order = await orders.create(cart, reservation, payment);
  await mail.sendConfirmation(order);
  return order;
}
`;

export const checkoutAfter = `import { inventory, mail, orders, payments } from "./services";
import { withRetries } from "./retry";
import type { Card, Cart } from "./types";

export async function checkout(cart: Cart, card: Card) {
  const reservation = await inventory.reserve(cart.items);
  try {
    const payment = await withRetries(() => payments.capture(card, cart.total), { attempts: 3 });
    const order = await orders.create(cart, reservation, payment);
    await mail.sendConfirmation(order);
    return order;
  } catch (error) {
    await inventory.release(reservation);
    throw error;
  }
}
`;

export const retry = `export async function withRetries<T>(run: () => Promise<T>, { attempts }: { attempts: number }): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
    }
  }
}
`;

const services = `export { inventory } from "./inventory";
export { mail } from "./mail";
export { orders } from "./orders";
export { payments } from "./payments";
`;

const types = `export type Cart = { id: string; items: { sku: string; quantity: number }[]; total: number };
export type Card = { token: string };
`;

const settingsScreen = `export function SettingsScreen() {
  return <ScrollView>{allSettings.map((setting) => <SettingRow key={setting.id} setting={setting} />)}</ScrollView>;
}
`;
