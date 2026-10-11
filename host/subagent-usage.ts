import { stat } from "node:fs/promises";
import { join } from "node:path";
import { subagentUsageFrom, type SubagentUsage } from "../shared/subagent-usage.ts";

/** Claude Code keeps each subagent's transcript beside a meta file that names the tool call that started the subagent. */
async function findTranscript(configDir: string, sessionId: string, toolCallId: string): Promise<string | null> {
  try {
    const metaFiles = await Array.fromAsync(new Bun.Glob(`*/${sessionId}/subagents/agent-*.meta.json`).scan({ cwd: join(configDir, "projects"), absolute: true }));
    const metas = await Promise.all(metaFiles.map(async (path) => ({ path, toolUseId: (await Bun.file(path).json().catch(() => null))?.toolUseId })));
    const meta = metas.find(({ toolUseId }) => toolUseId === toolCallId);
    return meta ? meta.path.replace(/\.meta\.json$/, ".jsonl") : null;
  } catch {
    return null;
  }
}

/** Reads what subagents spent from their transcripts, reading a transcript again only once it has changed. */
export class SubagentUsageReader {
  private readonly transcripts = new Map<string, string>();
  private readonly readings = new Map<string, { modifiedAt: number; size: number; usage: SubagentUsage | null }>();

  async usageOf(configDir: string, sessionId: string, toolCallIds: string[]): Promise<Record<string, SubagentUsage>> {
    const usages = await Promise.all(toolCallIds.map(async (toolCallId) => [toolCallId, await this.usageOfOne(configDir, sessionId, toolCallId)] as const));
    return Object.fromEntries(usages.filter((entry): entry is readonly [string, SubagentUsage] => entry[1] !== null));
  }

  private async usageOfOne(configDir: string, sessionId: string, toolCallId: string) {
    const transcript = await this.transcriptOf(configDir, sessionId, toolCallId);
    if (!transcript) return null;
    try {
      const { mtimeMs: modifiedAt, size } = await stat(transcript);
      const reading = this.readings.get(transcript);
      if (reading?.modifiedAt === modifiedAt && reading.size === size) return reading.usage;
      const usage = subagentUsageFrom(await Bun.file(transcript).text());
      this.readings.set(transcript, { modifiedAt, size, usage });
      return usage;
    } catch {
      return null;
    }
  }

  private async transcriptOf(configDir: string, sessionId: string, toolCallId: string) {
    const key = [configDir, sessionId, toolCallId].join("\n");
    const known = this.transcripts.get(key);
    if (known) return known;
    const found = await findTranscript(configDir, sessionId, toolCallId);
    if (found) this.transcripts.set(key, found);
    return found;
  }
}
