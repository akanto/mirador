import type { AskOption, CanvasAnswer, CanvasItem } from "../../shared/model.ts";
import type { ConversationService } from "../conversations.ts";
import type { Hub } from "../hub.ts";
import type { Store } from "../store.ts";

const RENDER_REPORT_TIMEOUT_MS = 6000;

export interface ShowRequest {
  title: string;
  html: string;
}

export interface AskRequest {
  question: string;
  html?: string;
  options: AskOption[];
  allowOther?: boolean;
}

export interface RenderReport {
  errors: string[];
}

export type RenderOutcome = RenderReport | "no-viewer";

interface AnswerWaiter {
  answered(answer: Pick<CanvasAnswer, "label" | "note">): void;
  withdrawn(): void;
}

export class CanvasService {
  private readonly answerWaiters = new Map<string, AnswerWaiter>();
  private readonly renderWaiters = new Map<string, (report: RenderReport) => void>();

  constructor(
    private readonly store: Store,
    private readonly hub: Hub,
    private readonly conversations: ConversationService,
  ) {}

  list(conversationId: string): CanvasItem[] {
    return this.store.listCanvasItems(conversationId);
  }

  async show(conversationId: string, request: ShowRequest): Promise<{ item: CanvasItem; render: RenderOutcome }> {
    const item = this.save({
      id: crypto.randomUUID(),
      conversationId,
      kind: "show",
      title: request.title,
      html: request.html,
      status: "shown",
      createdAt: Date.now(),
    });
    return { item, render: await this.waitForRenderReport(item) };
  }

  openAsk(conversationId: string, request: AskRequest): CanvasItem {
    return this.save({
      id: crypto.randomUUID(),
      conversationId,
      kind: "ask",
      title: request.question,
      question: request.question,
      html: request.html,
      options: request.options,
      allowOther: request.allowOther ?? false,
      status: "waiting",
      createdAt: Date.now(),
    });
  }

  /** Resolves with the user's answer, or rejects when `signal` aborts first; a later answer then arrives as the next message. */
  waitForAnswer(item: CanvasItem, signal: AbortSignal): Promise<Pick<CanvasAnswer, "label" | "note">> {
    return new Promise((resolve, reject) => {
      const stopWaiting = () => {
        this.answerWaiters.delete(item.id);
        reject(signal.reason ?? new Error("aborted"));
      };
      if (signal.aborted) return stopWaiting();
      signal.addEventListener("abort", stopWaiting, { once: true });
      this.answerWaiters.set(item.id, {
        answered: (answer) => {
          signal.removeEventListener("abort", stopWaiting);
          resolve(answer);
        },
        withdrawn: () => {
          signal.removeEventListener("abort", stopWaiting);
          reject(new Error("The user withdrew the question."));
        },
      });
    });
  }

  answer(itemId: string, label: string, note?: string) {
    const item = this.store.findCanvasItem(itemId);
    if (!item || item.kind !== "ask") throw new Error("Unknown question.");
    if (item.status !== "waiting") throw new Error("This question was already answered or withdrawn.");
    const waiter = this.answerWaiters.get(itemId);
    this.answerWaiters.delete(itemId);
    const trimmedNote = note?.trim() || undefined;
    this.save({
      ...item,
      status: "answered",
      answer: { label, note: trimmedNote, deliveredAs: waiter ? "tool-result" : "next-message" },
    });
    if (waiter) waiter.answered({ label, note: trimmedNote });
    else this.conversations.send(item.conversationId, answerAsMessage(item, label, trimmedNote)).catch(() => {});
  }

  withdrawWaitingAsks(conversationId: string) {
    this.store
      .listCanvasItems(conversationId)
      .filter((item) => item.status === "waiting")
      .forEach((item) => {
        const waiter = this.answerWaiters.get(item.id);
        this.answerWaiters.delete(item.id);
        this.save({ ...item, status: "cancelled" });
        waiter?.withdrawn();
      });
  }

  reportRender(itemId: string, report: RenderReport) {
    this.renderWaiters.get(itemId)?.(report);
  }

  private waitForRenderReport(item: CanvasItem): Promise<RenderOutcome> {
    if (!this.hub.hasSubscribers(item.conversationId)) return Promise.resolve("no-viewer");
    return new Promise((resolve) => {
      const settle = (outcome: RenderOutcome) => {
        clearTimeout(timer);
        this.renderWaiters.delete(item.id);
        resolve(outcome);
      };
      const timer = setTimeout(() => settle("no-viewer"), RENDER_REPORT_TIMEOUT_MS);
      this.renderWaiters.set(item.id, settle);
    });
  }

  private save(item: CanvasItem): CanvasItem {
    this.store.saveCanvasItem(item);
    this.hub.publishToConversation(item.conversationId, { type: "canvas.upserted", item });
    return item;
  }
}

export function answerAsToolResult(answer: Pick<CanvasAnswer, "label" | "note">) {
  return [`The user chose: ${answer.label}`, answer.note && `Their note: ${answer.note}`].filter(Boolean).join("\n");
}

function answerAsMessage(item: CanvasItem, label: string, note?: string) {
  return [`My answer to your question "${item.question}": ${label}`, note && `Note: ${note}`].filter(Boolean).join("\n");
}
