import { storedChoice } from "./stored-choice.ts";

/** The message box: a plain textarea, or one that formats as you type, as Slack's does. */
export type MessageBox = "plain" | "formatted";

export const messageBoxLabels: Record<MessageBox, string> = {
  plain: "Plain text",
  formatted: "Formats as you type",
};

const messageBox = storedChoice<MessageBox>("mirador-message-box", ["plain", "formatted"], "plain");

export const setMessageBox = messageBox.set;
export const useMessageBox = messageBox.use;

/** The formatting buttons over the formatted box: shown, or hidden until Aa shows them. */
export type FormatBarChoice = "hidden" | "shown";

export const formatBarLabels: Record<FormatBarChoice, string> = {
  hidden: "Hidden until Aa",
  shown: "Shown",
};

const formatBar = storedChoice<FormatBarChoice>("mirador-format-bar", ["hidden", "shown"], "hidden");

export const setFormatBar = formatBar.set;
export const useFormatBar = formatBar.use;
