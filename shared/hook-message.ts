export interface HookMessage {
  level: string | null;
  hook: string;
  lines: string[];
}

const LEVEL_LABEL = /^\*\*([A-Z][a-z]+):\*\* /;
const FIRST_HOOK_PREFIX = /^([A-Z][A-Za-z]*(?::\S+)?) says:/;

/** Claude Code puts "<Hook>:<matcher> says:" before every line a hook prints, and claude-agent-acp may put a bold level before it all. */
export function hookMessageIn(text: string): HookMessage | null {
  const level = LEVEL_LABEL.exec(text)?.[1] ?? null;
  const unlabelled = text.replace(LEVEL_LABEL, "").trimEnd();
  const hook = FIRST_HOOK_PREFIX.exec(unlabelled)?.[1];
  if (!hook) return null;
  const prefix = `${hook} says:`;
  const lines = unlabelled.split(/\r?\n/);
  if (!lines.every((line) => line.startsWith(prefix))) return null;
  return { level, hook, lines: lines.map((line) => line.slice(prefix.length).replace(/^ /, "")) };
}

/** A notice is what hooks usually say, so only a stronger level is worth naming. */
export const hookName = ({ level, hook }: HookMessage) => (level && level !== "Notice" ? `${level}: ${hook} hook` : `${hook} hook`);

/**
 * The same hook output as a `notice` update: claude-agent-acp lets its first line stand as the title and keeps the rest
 * as the description, every line still carrying the hook's prefix.
 */
export function hookNoticeIn(title: string, description: string | null | undefined): { hook: string; lines: string[] } | null {
  const hook = FIRST_HOOK_PREFIX.exec(title)?.[1];
  if (!hook) return null;
  const prefix = `${hook} says:`;
  const rest = description?.trimEnd();
  const lines = [title, ...(rest ? rest.split(/\r?\n/) : [])];
  if (!lines.every((line) => line.startsWith(prefix))) return null;
  return { hook, lines: lines.map((line) => line.slice(prefix.length).replace(/^ /, "")) };
}
