import type { ContextUsage } from "../shared/model.ts";

export type ContextLevel = "ok" | "high" | "full";

const oneDecimalUnder100 = (value: number) => String(value >= 100 ? Math.round(value) : Math.round(value * 10) / 10);

export function compactTokenCount(tokens: number) {
  if (tokens >= 1_000_000) return `${oneDecimalUnder100(tokens / 1_000_000)}M`;
  if (tokens >= 1_000) return `${oneDecimalUnder100(tokens / 1_000)}k`;
  return String(tokens);
}

export const usedShare = ({ used, size }: ContextUsage) => (size > 0 ? Math.min(1, used / size) : 0);

export function usedPercentLabel(usage: ContextUsage) {
  const percent = Math.round(usedShare(usage) * 100);
  return percent === 0 && usage.used > 0 ? "<1%" : `${percent}%`;
}

export const contextLevel = (share: number): ContextLevel => (share >= 0.9 ? "full" : share >= 0.75 ? "high" : "ok");

export const formatCost = ({ amount, currency }: NonNullable<ContextUsage["cost"]>) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: amount < 1 ? 4 : 2 }).format(amount);

export function contextHint(usage: ContextUsage) {
  const counts = `${usage.used.toLocaleString("en-US")} of ${usage.size.toLocaleString("en-US")} tokens`;
  return [
    `Context window: ${counts} in use (${usedPercentLabel(usage)}).`,
    "The agent reports this after each response (ACP usage_update). Close to the limit it compacts the conversation: older turns are replaced by a summary.",
    ...(usage.cost ? [`Cost so far, as the agent reports it: ${formatCost(usage.cost)}.`] : []),
  ].join("\n\n");
}
