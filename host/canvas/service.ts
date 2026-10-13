import { answersSummary, questionsOf } from "../../shared/ask.ts";
import { checklistItems, type Checklist } from "../../shared/checklist.ts";
import type { AskAnswerEntry, AskQuestion, CanvasAnswer, CanvasItem } from "../../shared/model.ts";
import { answersOf, type FindingDecision, type Review, type Tour } from "../../shared/review.ts";
import type { ConversationService } from "../conversations.ts";
import type { Hub } from "../hub.ts";
import type { Store } from "../store.ts";
import type { SystemNotifications } from "../system-notifications.ts";
import type { PageLibraries } from "../../shared/canvas-export.ts";
import { standalonePage } from "./export.ts";
import { saveIntoWorkspace } from "./save-to-project.ts";
import {
  applyChecklistEdit,
  CHECKLIST_NOT_CHANGED,
  heardOf,
  newChecklist,
  noteOfTicks,
  tickedByUser,
  unheardTicks,
  type ChecklistEdit,
  type ChecklistNote,
  type ChecklistRequest,
} from "./checklist.ts";
import { answersToConversations } from "../review/answers.ts";
import { carryOverAnswerChoices, carryOverChoices, ofSamePullRequest, reviewToCarryOverFrom } from "../review/carry-over.ts";
import { applyReviewEdit, readEditAnchors, REVIEW_NOT_CHANGED, type ReviewEdit } from "../review/edit.ts";
import { openInIdea } from "../review/editor.ts";
import { ghCli, postPendingReview, type GitHubCli } from "../review/github.ts";
import { allOrEveryProblem, reviewedFileLines, ReviewProblems, snapshotReview, type ReviewRequest } from "../review/snapshot.ts";
import { snapshotTour, touredFileLines, type TourRequest } from "../review/tour.ts";

const RENDER_REPORT_TIMEOUT_MS = 6000;

export interface ShowRequest {
  title: string;
  html: string;
}

/** One question, or several that the user answers page by page and the agent hears all at once. */
export type AskRequest = AskQuestion | { questions: AskQuestion[] };

export interface RenderReport {
  errors: string[];
}

export type RenderOutcome = RenderReport | "no-viewer";

type ReviewItem = CanvasItem & { review: Review };
type TourItem = CanvasItem & { tour: Tour };
export type ChecklistCanvasItem = CanvasItem & { checklist: Checklist };

const UNKNOWN_WALKTHROUGH = "Unknown review or tour.";

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
    /** The address agents were given for the canvas libraries, which their pages name. */
    private readonly assetsOrigin: string,
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
    const asked = "questions" in request ? severalQuestionsAsked(request.questions) : singleQuestionAsked(request);
    const item = this.save({
      id: crypto.randomUUID(),
      conversationId,
      kind: "ask",
      ...asked,
      ...(shownBefore.length > 0 && { shownBefore }),
      status: "waiting",
      createdAt: Date.now(),
    });
    this.notifications.notify(conversationId, { kind: "question", question: item.title });
    return item;
  }

  /** Resolves with the user's answer, or rejects when `signal` aborts first; a later answer then arrives as the next message. */
  waitForAnswer(item: CanvasItem, signal: AbortSignal): Promise<Pick<CanvasAnswer, "label" | "note" | "answers">> {
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

  answer(itemId: string, label: string, note?: string, answers?: AskAnswerEntry[]) {
    const item = this.store.findCanvasItem(itemId);
    if (!item || item.kind !== "ask") throw new Error("Unknown question.");
    if (item.status !== "waiting") throw new Error("This question was already answered or withdrawn.");
    const given = answersFor(item, label, note, answers);
    const waiter = this.answerWaiters.get(itemId);
    this.answerWaiters.delete(itemId);
    this.save({ ...item, status: "answered", answer: { ...given, deliveredAs: waiter ? "tool-result" : "next-message" } });
    if (waiter) waiter.answered(given);
    else this.conversations.send(item.conversationId, answerAsMessage(item, given)).catch(() => {});
  }

  async review(conversationId: string, request: ReviewRequest): Promise<ReviewItem> {
    const [snapshot, answers] = await allOrEveryProblem(snapshotReview(request), answersToConversations(request, this.gh));
    const earlier = this.latestReviewOf(conversationId, snapshot);
    const review = earlier
      ? { ...snapshot, findings: carryOverChoices(earlier.findings, snapshot.findings, ofSamePullRequest(earlier, snapshot)), answers: carryOverAnswerChoices(answersOf(earlier), answers) }
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

  async tour(conversationId: string, request: TourRequest): Promise<TourItem> {
    const tour = await snapshotTour(request);
    return this.save({
      id: crypto.randomUUID(),
      conversationId,
      kind: "tour",
      title: request.title,
      tour,
      status: "shown",
      createdAt: Date.now(),
    }) as TourItem;
  }

  /** Publishing again replaces the conversation's checklist; the result names what the user had ticked on the one it replaces. */
  publishChecklist(conversationId: string, request: ChecklistRequest) {
    const replaced = this.currentChecklist(conversationId);
    const item = this.save({
      id: crypto.randomUUID(),
      conversationId,
      kind: "checklist",
      title: request.title,
      checklist: newChecklist(request, replaced?.checklist),
      status: "shown",
      createdAt: Date.now(),
    }) as ChecklistCanvasItem;
    return { item, replaced: replaced && { title: replaced.title, ticks: unheardTicks(replaced.checklist) } };
  }

  /** The agent's change to its checklist, in place; the agent hears what the user ticked since it last did. */
  editChecklist(conversationId: string, edit: ChecklistEdit) {
    const current = this.currentChecklist(conversationId);
    if (!current) throw new ReviewProblems(["This conversation has no checklist; publish one with the checklist tool."], CHECKLIST_NOT_CHANGED);
    const { checklist, changed, added, removed } = applyChecklistEdit(current.checklist, edit);
    const ticks = unheardTicks(checklist);
    const agentEdit = { at: Date.now(), items: [...changed, ...added] };
    const item = this.save({ ...current, checklist: { ...heardOf(checklist, ticks), agentEdit } }) as ChecklistCanvasItem;
    return { item, changed, added, removed, ticks };
  }

  tickChecklistItem(itemId: string, checklistItemId: string, done: boolean) {
    const item = this.store.findCanvasItem(itemId);
    if (!item?.checklist) throw new Error("Unknown checklist.");
    if (!checklistItems(item.checklist).some(({ id }) => id === checklistItemId)) throw new Error("Unknown checklist item.");
    this.save({ ...item, checklist: tickedByUser(item.checklist, checklistItemId, done) });
  }

  checklistNote(conversationId: string): ChecklistNote | null {
    const current = this.currentChecklist(conversationId);
    const ticks = current ? unheardTicks(current.checklist) : [];
    if (!current || ticks.length === 0) return null;
    return {
      text: noteOfTicks(current.title, ticks),
      heard: () => {
        const latest = this.store.findCanvasItem(current.id);
        if (latest?.checklist) this.save({ ...latest, checklist: heardOf(latest.checklist, ticks) });
      },
    };
  }

  /**
   * Changes parts of a review already shown, in the same canvas item, so the user keeps their place in it. The edit is
   * applied to the review as it is once git has been read, so a choice the user made meanwhile stays.
   */
  async editReview(conversationId: string, edit: ReviewEdit & { review?: string }) {
    const target = this.reviewToEdit(conversationId, edit.review);
    const anchors = await readEditAnchors(target.review, edit);
    const latest = this.reviewItem(target.id);
    const { review, changed, removed } = applyReviewEdit(latest.review, edit, anchors);
    const item = this.save({ ...latest, review: { ...review, agentEdit: { at: Date.now(), parts: changed } } }) as ReviewItem;
    return { item, changed, removed };
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

  /** A page the agent showed, as a file of its own that draws outside Mirador. */
  async exportPage(itemId: string, libraries: PageLibraries) {
    const page = this.store.findCanvasItem(itemId);
    if (page?.kind !== "show" || page.html === undefined) throw new Error("Only a page the agent showed can be copied or saved.");
    return { page, html: await standalonePage({ title: page.title, html: page.html }, this.assetsOrigin, libraries) };
  }

  /** Writes the page into the conversation's workspace, at a path inside it; the path it was saved at comes back. */
  async savePageToProject(itemId: string, path: string, libraries: PageLibraries, replace: boolean) {
    const { page, html } = await this.exportPage(itemId, libraries);
    const workspace = this.store.findWorkspace(this.conversations.get(page.conversationId).workspaceId);
    if (!workspace) throw new Error("The workspace no longer exists.");
    return saveIntoWorkspace(workspace.path, path, html, { replace });
  }

  openInEditor(itemId: string, path: string, line: number) {
    const { review, tour } = this.store.findCanvasItem(itemId) ?? {};
    const root = review?.repository ?? tour?.folder;
    if (!root) throw new Error(UNKNOWN_WALKTHROUGH);
    openInIdea(root, path, line);
  }

  async readReviewedFile(itemId: string, path: string) {
    const { review, tour } = this.store.findCanvasItem(itemId) ?? {};
    if (review) return reviewedFileLines(review, path);
    if (tour) return touredFileLines(tour, path);
    throw new Error(UNKNOWN_WALKTHROUGH);
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

  private reviewToEdit(conversationId: string, itemId: string | undefined) {
    const reviews = this.store.listCanvasItems(conversationId).filter((item) => item.review);
    const item = itemId === undefined ? reviews.at(-1) : reviews.find(({ id }) => id === itemId);
    if (item) return item as ReviewItem;
    const problem = itemId === undefined ? "This conversation has no review to change; publish one with the review tool." : `review: ${itemId} is not a review in this conversation.`;
    throw new ReviewProblems([problem], REVIEW_NOT_CHANGED);
  }

  private currentChecklist(conversationId: string) {
    return this.store.listCanvasItems(conversationId).findLast((item) => item.checklist) as ChecklistCanvasItem | undefined;
  }

  private latestReviewOf(conversationId: string, change: Review) {
    const reviews = this.store.listCanvasItems(conversationId).flatMap((item) => (item.review ? [item.review] : []));
    return reviewToCarryOverFrom(reviews, change);
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

const singleQuestionAsked = ({ question, html, options, allowOther, optionWidth }: AskQuestion): Partial<CanvasItem> & Pick<CanvasItem, "title"> => ({
  title: question,
  question,
  html,
  options,
  allowOther: allowOther ?? false,
  ...(optionWidth && { optionWidth }),
});

const severalQuestionsAsked = (questions: AskQuestion[]) => ({
  title: `${questions.length} questions: ${questions[0]!.question}`,
  question: questions[0]!.question,
  questions,
});

type GivenAnswer = Pick<CanvasAnswer, "label" | "note" | "answers">;

/** What the user sent, checked against what was asked: one answer for a question, one for each of several. */
function answersFor(item: CanvasItem, label: string, note: string | undefined, answers: AskAnswerEntry[] | undefined): GivenAnswer {
  const questions = questionsOf(item);
  if (!item.questions) {
    if (answers) throw new Error("This question takes one answer.");
    return { label, note: note?.trim() || undefined };
  }
  if (!answers || answers.length !== questions.length || answers.some((entry) => !entry.label.trim())) {
    throw new Error(`Answer all ${questions.length} questions.`);
  }
  const entries = answers.map(({ label, note }, index) => ({ question: questions[index]!.question, label, note: note?.trim() || undefined }));
  return { label: answersSummary(entries), answers: entries };
}

const noteLine = (note: string | undefined, prefix: string) => (note ? [`${prefix}${note}`] : []);

export function answerAsToolResult({ label, note, answers }: GivenAnswer) {
  if (answers) {
    const each = answers.flatMap((entry, index) => [`${index + 1}. ${entry.question}`, `   The user chose: ${entry.label}`, ...noteLine(entry.note, "   Their note: ")]);
    return [`The user answered ${answers.length} questions:`, ...each].join("\n");
  }
  return [`The user chose: ${label}`, ...noteLine(note, "Their note: ")].join("\n");
}

function answerAsMessage(item: CanvasItem, { label, note, answers }: GivenAnswer) {
  if (answers) {
    const each = answers.flatMap((entry, index) => [`${index + 1}. "${entry.question}": ${entry.label}`, ...noteLine(entry.note, "   Note: ")]);
    return ["My answers to your questions:", ...each].join("\n");
  }
  return [`My answer to your question "${item.question}": ${label}`, ...noteLine(note, "Note: ")].join("\n");
}
