import { newerVersionLabel, type NewerVersion } from "../../../shared/newer-version.ts";
import { MIRADOR_VERSION } from "../../../shared/version.ts";
import { waitingLabels, type WaitingConversation, type WaitingSummary, type WaitingTone } from "../../../shared/waiting.ts";
import type { HostStatus } from "./host-supervisor.ts";
import type { UpdateOffer } from "./self-update.ts";

export type TrayAction =
  | "open"
  | "open-conversation"
  | "download-newer-version"
  | "check-for-update"
  | "install-update"
  | "restart-host"
  | "toggle-background"
  | "toggle-open-at-login"
  | "quit";

const trayActions: readonly string[] = [
  "open",
  "open-conversation",
  "download-newer-version",
  "check-for-update",
  "install-update",
  "restart-host",
  "toggle-background",
  "toggle-open-at-login",
  "quit",
] satisfies TrayAction[];
export const isTrayAction = (action: unknown): action is TrayAction => typeof action === "string" && trayActions.includes(action);

export type TrayItem =
  | { type: "separator" }
  | { type: "normal"; label: string; action?: TrayAction; data?: { conversationId: string }; enabled?: boolean; checked?: boolean };

export interface TrayState {
  status: HostStatus | "starting";
  hostRunsInBackground: boolean;
  openAtLogin: boolean;
  newerVersion: NewerVersion | null;
  /** A release build that downloads and installs newer releases itself; any other only links to them. */
  updatesItself: boolean;
  update: UpdateOffer | null;
  /** Most urgent first. */
  waiting: readonly WaitingConversation[];
}

const statusLabels: Record<TrayState["status"], string> = {
  starting: "Host: starting...",
  stopped: "Host: not running",
  owned: "Host: running, started by this app",
  external: "Host: running, started elsewhere",
  background: "Host: running in the background",
};

function updateItems(update: UpdateOffer | null): TrayItem[] {
  if (!update) return [];
  if (update.stage === "blocked") return [{ type: "normal", label: `Mirador ${update.version} is out: ${update.blockedBy}`, enabled: false }];
  if (update.stage === "downloading") return [{ type: "normal", label: `Downloading Mirador ${update.version}...`, enabled: false }];
  return [{ type: "normal", label: `Restart to update to Mirador ${update.version}`, action: "install-update" }];
}

/**
 * A release is downloaded by the app that updates itself, unless it is already, and otherwise links to its download page,
 * as it does where the app cannot install it. New commits on a checkout's upstream are only told.
 */
function newerVersionItems({ newerVersion, updatesItself, update }: TrayState): TrayItem[] {
  if (!newerVersion) return [];
  if (newerVersion.kind === "checkout") return [{ type: "normal", label: newerVersionLabel(newerVersion), enabled: false }];
  if (update && update.stage !== "blocked") return [];
  const action = updatesItself && !update ? "check-for-update" : "download-newer-version";
  return [{ type: "normal", label: `${newerVersionLabel(newerVersion)}: download`, action }];
}

const MAX_WAITING_SHOWN = 10;
const MAX_TITLE_LENGTH = 48;

/**
 * Linux's tray reads its menu with a JSON parser that ends a string at its first quote and counts every bracket, so a
 * title keeps none of those, and Windows takes & for a shortcut key.
 */
export function menuLabel(text: string, platform: NodeJS.Platform) {
  const plain = text.replace(/\s+/g, " ").trim().replace(/["\\]/g, "'").replace(/[{[]/g, "(").replace(/[}\]]/g, ")");
  const characters = Array.from(plain);
  const short = characters.length > MAX_TITLE_LENGTH ? `${characters.slice(0, MAX_TITLE_LENGTH - 1).join("").trimEnd()}…` : plain;
  return platform === "win32" ? short.replaceAll("&", "&&") : short;
}

function waitingItem({ conversationId, title, workspace, tone }: WaitingConversation, platform: NodeJS.Platform): TrayItem {
  const where = workspace ? ` · ${menuLabel(workspace, platform)}` : "";
  return { type: "normal", label: `${waitingLabels[tone]}: ${menuLabel(title, platform)}${where}`, action: "open-conversation", data: { conversationId } };
}

function waitingItems(waiting: readonly WaitingConversation[], platform: NodeJS.Platform): TrayItem[] {
  if (waiting.length === 0) return [];
  const hidden = waiting.length - MAX_WAITING_SHOWN;
  return [
    { type: "normal", label: "Waiting for you", enabled: false },
    ...waiting.slice(0, MAX_WAITING_SHOWN).map((conversation) => waitingItem(conversation, platform)),
    ...(hidden > 0 ? [{ type: "normal", label: `${hidden} more…`, action: "open" } satisfies TrayItem] : []),
    { type: "separator" },
  ];
}

const OPEN_CONVERSATION_PREFIX = "open-conversation:";

export type NativeTrayItem = { type: "separator" } | { type: "normal"; label: string; action?: string; enabled?: boolean; checked?: boolean };

/** Electrobun forgets an item's data once it is clicked, so a conversation's id travels in the item's action instead. */
export const nativeTrayMenu = (items: TrayItem[]): NativeTrayItem[] =>
  items.map((item) => {
    if (item.type === "separator" || !item.data) return item;
    const { data, ...rest } = item;
    return { ...rest, action: `${OPEN_CONVERSATION_PREFIX}${data.conversationId}` };
  });

export function clickedTrayItem(action: unknown): { action: TrayAction; conversationId?: string } | null {
  if (typeof action === "string" && action.startsWith(OPEN_CONVERSATION_PREFIX)) {
    const conversationId = action.slice(OPEN_CONVERSATION_PREFIX.length);
    return conversationId ? { action: "open-conversation", conversationId } : null;
  }
  return isTrayAction(action) && action !== "open-conversation" ? { action } : null;
}

export function trayMenu(state: TrayState, platform: NodeJS.Platform = process.platform): TrayItem[] {
  const restartable = state.status !== "external" && state.status !== "starting";
  return [
    ...waitingItems(state.waiting, platform),
    { type: "normal", label: statusLabels[state.status], enabled: false },
    { type: "normal", label: `Mirador ${MIRADOR_VERSION}`, enabled: false },
    ...updateItems(state.update),
    ...newerVersionItems(state),
    { type: "normal", label: "Open", action: "open" },
    { type: "separator" },
    { type: "normal", label: restartable ? "Restart host" : "Restart host (not started by this app)", action: "restart-host", enabled: restartable },
    { type: "normal", label: "Run host in the background", action: "toggle-background", checked: state.hostRunsInBackground },
    { type: "normal", label: "Open at login", action: "toggle-open-at-login", checked: state.openAtLogin },
    { type: "separator" },
    { type: "normal", label: "Quit", action: "quit" },
  ];
}

export const waitingBadge = (waitingCount: number) => (waitingCount > 0 ? String(waitingCount) : "");

export type TrayDot = "needs-you" | "done";

/** A decision or a failed turn needs you, so the dot is red; a turn that ended unseen makes it green. Your own Unread marks get none. */
export function trayDot(mostUrgent: WaitingTone | null): TrayDot | null {
  if (mostUrgent === "decision" || mostUrgent === "failed") return "needs-you";
  if (mostUrgent === "done") return "done";
  return null;
}

const dotEmoji: Record<TrayDot, string> = { "needs-you": "🔴", done: "🟢" };

/** macOS draws its template icon in one colour, so the dot goes beside it, before the count. */
export function trayTitle({ count, mostUrgent }: Pick<WaitingSummary, "count" | "mostUrgent">) {
  const dot = trayDot(mostUrgent);
  return [dot && dotEmoji[dot], waitingBadge(count)].filter(Boolean).join(" ");
}

/** The colour icon of Linux and Windows panels, with the dot in its corner while there is one. Windows reads tray icons only as .ico. */
export function colourTrayImage(dot: TrayDot | null, platform: NodeJS.Platform) {
  const extension = platform === "win32" ? "ico" : "png";
  return `views://assets/${dot ? `tray-icon-${dot}` : "app-icon"}.${extension}`;
}

/** On macOS a tray title is text beside the icon, kept for the waiting count; Linux panels show it as the icon's tooltip. */
export const firstTrayTitle = (platform: NodeJS.Platform, appName: string) => (platform === "darwin" ? "" : appName);

export function restartDetail(appName: string, runningTurns: number): string {
  if (runningTurns === 0) return `${appName} closes and opens again.`;
  const turns = runningTurns === 1 ? "turn" : "turns";
  return `${appName} closes and opens again. ${runningTurns} running ${turns} will stop.`;
}
