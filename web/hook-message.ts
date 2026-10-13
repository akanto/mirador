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
