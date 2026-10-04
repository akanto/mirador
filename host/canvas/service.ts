import type { AskOption, CanvasAnswer, CanvasItem } from "../../shared/model.ts";
import { answersOf, type FindingDecision, type Review } from "../../shared/review.ts";
import type { ConversationService } from "../conversations.ts";
import type { Hub } from "../hub.ts";
import type { Store } from "../store.ts";
import type { SystemNotifications } from "../system-notifications.ts";
import { answersToConversations } from "../review/answers.ts";
import { carryOverAnswerChoices, carryOverChoices, isSameChange } from "../review/carry-over.ts";
import { openInIdea } from "../review/editor.ts";
import { ghCli, postPendingReview, type GitHubCli } from "../review/github.ts";
import { allOrEveryProblem, reviewedFileLines, snapshotReview, type ReviewRequest } from "../review/snapshot.ts";

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

type ReviewItem = CanvasItem & { review: Review };

export interface FindingChange {
  decision?: FindingDecision;
  body?: string;
}

export interface AnswerChange extends FindingChange {
  resolve?: boolean;
}

interface AnswerWaiter {
  answered(answer: Pick<CanvasAnswer, "label" | "note">): void;
  withdrawn(): void;
}

export class CanvasService {
  private readonly answerWaiters = new Map<string, AnswerWaiter>();
  private readonly renderWaiters = new Map<string, (report: RenderReport) => void>();
  private readonly reviewsBeingPosted = new Set<string>();

  constructor(
    private readonly store: Store,
    private readonly hub: Hub,
    private readonly conversations: ConversationService,
    private readonly notifications: SystemNotifications,
    private readonly gh: GitHubCli = ghCli,
  ) {}

  list(conversationId: string): CanvasItem[] {
    return this.store.listCanvasItems(conversationId).map((item) => this.withoutInterruptedPost(item));
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
    const shownBefore = this.pagesShownSinceUserSpoke(conversationId).map(({ id }) => id);
    const item = this.save({
      id: crypto.randomUUID(),
      conversationId,
      kind: "ask",
      title: request.question,
      question: request.question,
      html: request.html,
      options: request.options,
      allowOther: request.allowOther ?? false,
      ...(shownBefore.length > 0 && { shownBefore }),
      status: "waiting",
      createdAt: Date.now(),
    });
    this.notifications.notify(conversationId, { kind: "question", question: request.question });
    return item;
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

  async review(conversationId: string, request: ReviewRequest): Promise<ReviewItem> {
    const [snapshot, answers] = await allOrEveryProblem(snapshotReview(request), answersToConversations(request, this.gh));
    const earlier = this.latestReviewOf(conversationId, snapshot);
    const review = earlier
      ? { ...snapshot, findings: carryOverChoices(earlier.findings, snapshot.findings), answers: carryOverAnswerChoices(answersOf(earlier), answers) }
      : { ...snapshot, answers };
    return this.save({
      id: crypto.randomUUID(),
      conversationId,
      kind: "review",
      title: request.title,
      review,
      status: "shown",
      createdAt: Date.now(),
    }) as ReviewItem;
  }

  updateFinding(itemId: string, findingId: string, change: FindingChange) {
    const item = this.reviewItem(itemId);
    const finding = item.review.findings.find(({ id }) => id === findingId);
    if (!finding) throw new Error("Unknown finding.");
    if (finding.postedAs) throw new Error("This finding is already on the pull request; change it there.");
    const body = change.body?.trim();
    const reworded = body && body !== finding.body && { body, agentBody: finding.agentBody ?? finding.body };
    const changed = { ...finding, ...(change.decision && { decision: change.decision }), ...reworded };
    this.saveReview(item, { findings: item.review.findings.map((each) => (each.id === findingId ? changed : each)) });
  }

  updateAnswer(itemId: string, answerId: string, change: AnswerChange) {
    const item = this.reviewItem(itemId);
    const answer = answersOf(item.review).find(({ id }) => id === answerId);
    if (!answer) throw new Error("Unknown answer.");
    if (answer.postedAs) throw new Error("This answer is already on the pull request; change it there.");
    if (change.resolve && !answer.canResolve) throw new Error("GitHub does not let you resolve this conversation.");
    const body = change.body?.trim();
    const reworded = body && body !== answer.body && { body, agentBody: answer.agentBody ?? answer.body };
    const changed = { ...answer, ...(change.decision && { decision: change.decision }), ...(change.resolve !== undefined && { resolve: change.resolve }), ...reworded };
    this.saveReview(item, { answers: answersOf(item.review).map((each) => (each.id === answerId ? changed : each)) });
  }

  /** Adds the kept findings and answers to the user's pending review on the pull request; each records how that went. */
  async postReview(itemId: string) {
    if (this.reviewsBeingPosted.has(itemId)) return;
    this.reviewsBeingPosted.add(itemId);
    const item = this.reviewItem(itemId);
    this.saveReview(item, { posting: true });
    try {
      const outcome = await postPendingReview(item.review, this.gh);
      const latest = this.reviewItem(itemId);
      const findings = latest.review.findings.map((finding) => {
        const threadId = outcome.threadIds.get(finding.id);
        if (threadId) return { ...finding, postedAs: { threadId }, postError: undefined };
        const postError = outcome.errors.get(finding.id);
        return postError ? { ...finding, postError } : finding;
      });
      const answers = answersOf(latest.review).map((answer) => {
        const url = outcome.answerUrls.get(answer.id);
        const postError = outcome.errors.get(answer.id);
        const resolved = answer.resolved || outcome.resolvedAnswerIds.has(answer.id);
        return url ? { ...answer, postedAs: { url }, resolved, postError } : postError ? { ...answer, postError } : answer;
      });
      this.saveReview(latest, { findings, answers, pendingReviewUrl: outcome.pendingReviewUrl });
    } finally {
      this.reviewsBeingPosted.delete(itemId);
      this.saveReview(this.reviewItem(itemId), { posting: false });
    }
  }

  openInEditor(itemId: string, path: string, line: number) {
    openInIdea(this.reviewItem(itemId).review.repository, path, line);
  }

  async readReviewedFile(itemId: string, path: string) {
    return reviewedFileLines(this.reviewItem(itemId).review, path);
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
    if (!this.hub.isShown(item.conversationId)) return Promise.resolve("no-viewer");
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

  /** A question replaces the page on the canvas, so it carries the pages its turn showed before it. */
  private pagesShownSinceUserSpoke(conversationId: string) {
    const items = this.store.listCanvasItems(conversationId);
    const sinceLastQuestion = items.slice(items.findLastIndex((item) => item.kind === "ask") + 1);
    const userSpokeAt = this.store.lastUserMessageAt(conversationId) ?? 0;
    return sinceLastQuestion.filter((item) => item.kind === "show" && item.createdAt >= userSpokeAt);
  }

  private reviewItem(itemId: string): ReviewItem {
    const item = this.store.findCanvasItem(itemId);
    if (!item?.review) throw new Error("Unknown review.");
    return item as ReviewItem;
  }

  private latestReviewOf(conversationId: string, change: Review) {
    return this.store
      .listCanvasItems(conversationId)
      .findLast((item) => item.review && isSameChange(item.review, change))?.review;
  }

  private saveReview(item: ReviewItem, change: Partial<Review>) {
    this.save({ ...item, review: { ...item.review, ...change } });
  }

  /** A host that stopped while posting a review left it marked as posting; a client may still hold it so. */
  private withoutInterruptedPost(item: CanvasItem): CanvasItem {
    if (!item.review?.posting || this.reviewsBeingPosted.has(item.id)) return item;
    return { ...item, review: { ...item.review, posting: false }, updatedAt: Date.now() };
  }

  private save(change: CanvasItem): CanvasItem {
    const item = { ...change, updatedAt: Date.now() };
    this.store.saveCanvasItem(item);
    this.hub.publishToConversation(item.conversationId, { type: "canvas.upserted", item });
    if (item.kind === "ask") this.conversations.questionsChanged(item.conversationId);
    return item;
  }
}

export function answerAsToolResult(answer: Pick<CanvasAnswer, "label" | "note">) {
  return [`The user chose: ${answer.label}`, answer.note && `Their note: ${answer.note}`].filter(Boolean).join("\n");
}

function answerAsMessage(item: CanvasItem, label: string, note?: string) {
  return [`My answer to your question "${item.question}": ${label}`, note && `Note: ${note}`].filter(Boolean).join("\n");
}
