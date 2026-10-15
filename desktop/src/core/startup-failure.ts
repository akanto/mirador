import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface StartupFailureNotice {
  title: string;
  message: string;
  detail?: string;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const detailsOf = (error: unknown) => (error instanceof Error && error.stack ? error.stack : String(error));

function appended(logPath: string, line: string) {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, line);
    return true;
  } catch {
    return false;
  }
}

/**
 * Electrobun ends the app without a word when its main script throws, so a start that fails is written to the log and
 * told to the user. The notice names the log only when the failure made it there.
 */
export function recordStartupFailure(appName: string, error: unknown, logPath: string, now = new Date()): StartupFailureNotice {
  const notice = { title: appName, message: `${appName} could not start: ${messageOf(error)}` };
  const logged = appended(logPath, `${now.toISOString()} ${appName} could not start: ${detailsOf(error)}\n`);
  return logged ? { ...notice, detail: `The details are in ${logPath}.` } : notice;
}
