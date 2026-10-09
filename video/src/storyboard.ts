import type { CameraKey, ClipScene, ClipTime, Scene } from "./timeline.ts";

/** The score's beat, at 96 beats a minute: the cuts after the review fall on it. */
export const BEAT = 60 / 96;

/** The canvas and the chat from the app's top edge, where the canvas's buttons are, down past the edit to allow. */
const CANVAS_AND_CHAT = { x: 256, y: 0, width: 1280, height: 720 };
/** The top of the canvas, from its Changes button down past the list of changed files. */
const TOP_OF_CANVAS = { x: 836, y: 0, width: 700, height: 394 };

/** A glimpse of a moment for half a beat, cut in with a burst of light. */
function flash(id: string, clip: string, at: [string, number], look: CameraKey["look"], zoom?: number): ClipScene {
  const until: ClipTime = [at[0], at[1] + 0.4];
  return { kind: "clip", id, clip, shots: [{ from: at, to: until }], camera: [{ at, look, ...(zoom ? { zoom } : {}) }], seconds: BEAT / 2, flash: true, fadeInFrames: 0 };
}

/**
 * The trailer, scene by scene. A clip scene plays stretches of a filmed clip (capture/trailer.spec.ts films them) and
 * moves the camera to boxes the capture measured, at moments it named; a scene lasts at least as long as its lines of
 * narration (narration/lines.ts). To show a new feature: film it as a clip, add its line, add a scene here.
 */
export const STORYBOARD: Scene[] = [
  {
    kind: "text-wall",
    id: "wall",
    seconds: 14.4,
    narration: [
      { line: "wall", at: 0.3 },
      { line: "wallOfText", at: 6.4 },
      { line: "human", at: 8.1 },
      { line: "picture", at: 9.45, musicDipsTo: 0.55 },
    ],
    goesBlackAt: 7.6,
    pictureAt: 9.3,
    statement: { parts: ["Humans", "see faster", "than they read."], at: 12.3 },
  },
  { kind: "logo", id: "logo", seconds: 3.8, narration: [{ line: "canvas", at: 0.8 }], fadeInFrames: 0 },
  {
    kind: "clip",
    id: "show",
    clip: "show",
    shots: [
      { from: ["typing", -0.5], to: "sent", speed: 1.6 },
      { from: "sent", to: ["canvasShown", -0.2], speed: 1.25 },
      { from: ["canvasShown", -0.2], to: ["turnEnded", 1.5] },
    ],
    camera: [
      { at: ["typing", -0.5], look: "composer", zoom: 1.6 },
      { at: ["sent", 0.2], look: "timeline", zoom: 1.4 },
      { at: ["canvasShown", -0.3], look: "canvas", zoom: 1.3 },
      { at: ["turnEnded", -0.2], look: "app" },
    ],
    caption: { kicker: "Show", title: "Your agent draws what it means.", at: 6.8, seconds: 3.6 },
    narration: [{ line: "show", at: 1.2 }],
  },
  {
    kind: "clip",
    id: "overview",
    clip: "overview",
    shots: [
      { from: 3.5, to: ["needsYou", -0.3], speed: 1.3 },
      { from: ["needsYou", -0.3], to: 12 },
    ],
    camera: [
      { at: 3.5, look: "app" },
      { at: 4.2, look: { x: 0, y: 330, width: 256, height: 420 }, zoom: 1.55 },
    ],
    caption: { kicker: "Every project", title: "See who needs you.", at: 3.6, seconds: 3.4, side: "right" },
    narration: [{ line: "overview", at: 0.3 }],
  },
  {
    kind: "clip",
    id: "ask",
    clip: "ask",
    shots: [
      { from: ["opened", -0.9], to: ["picked", 0.3] },
      { from: ["picked", 0.3], to: ["submitted", 0.3], speed: 1.3 },
      { from: ["submitted", 0.3], to: ["turnEnded", 1.4] },
    ],
    camera: [
      { at: ["opened", -0.9], look: { x: 0, y: 330, width: 256, height: 420 }, zoom: 1.55 },
      { at: ["opened", 0.1], look: "app" },
      { at: ["submitted", 0.4], look: "timeline", zoom: 1.35 },
    ],
    caption: { kicker: "Ask", title: "Decisions come with pictures.", at: 1.8, seconds: 3.6 },
    narration: [{ line: "ask", at: 0.6 }],
  },
  {
    kind: "clip",
    id: "review",
    clip: "review",
    shots: [
      { from: ["typing", -0.4], to: "sent", speed: 1.8 },
      { from: "sent", to: ["reviewShown", -0.2], speed: 1.5 },
      { from: ["reviewShown", -0.2], to: "flow", speed: 1.2 },
      { from: "flow", to: ["flowStep3", -0.2], speed: 1.8 },
      { from: ["findings", -0.1], to: "askOpened", speed: 1.2 },
      { from: "askOpened", to: "questionTyped", speed: 1.6 },
      { from: "questionTyped", to: ["asked", 0.5], speed: 1.2 },
      { from: ["asked", 0.5], to: "chatShown", speed: 1.3 },
      { from: "chatShown", to: ["answered", 1.6], speed: 0.8 },
      { from: ["answered", 1.6], to: ["dropped", -0.9], speed: 1.8 },
      { from: ["dropped", -0.9], to: ["postClicked", -0.5], speed: 1.5 },
      { from: ["postClicked", -0.5], to: ["posted", 1.8] },
    ],
    camera: [
      { at: ["typing", -0.4], look: "composer", zoom: 1.6 },
      { at: ["reviewShown", -0.3], look: "canvas", zoom: 1.12 },
      { at: ["flowStep", 0.2], look: { x: 560, y: 90, width: 962, height: 380 }, zoom: 1.55 },
      { at: ["findings", 0.2], look: "blocker", zoom: 1.2 },
      { at: ["askOpened", 0.1], look: "askDialog", zoom: 1.22 },
      { at: ["chatShown", 0.1], look: "app" },
      { at: "answered", look: { x: 852, y: 99, width: 668, height: 130 }, zoom: 2.2 },
      { at: ["answered", 1.8], look: { x: 836, y: 393, width: 700, height: 394 }, zoom: 2.19 },
    ],
    caption: { kicker: "Review", title: "A guided tour of the change.", at: 4.2, seconds: 3.4 },
    narration: [
      { line: "review", at: 3.4 },
      { line: "reviewAsk", at: 10.8 },
      { line: "reviewPost", at: 19.2 },
    ],
  },
  {
    kind: "clip",
    id: "edit",
    clip: "edit",
    shots: [{ from: ["approval", -0.5], to: ["allowed", 0.45], speed: 1.08 }],
    camera: [{ at: ["approval", -0.5], look: CANVAS_AND_CHAT, zoom: 1.2 }],
    caption: { kicker: "Approve", title: "Every edit, with its diff.", at: 0.3, seconds: 3 },
    narration: [{ line: "edit", at: 0.5, musicDipsTo: 0.6 }],
    seconds: 6 * BEAT,
    fadeInFrames: 0,
  },
  {
    kind: "clip",
    id: "changes",
    clip: "edit",
    shots: [
      { from: ["turnEnded", 0.6], to: ["turnListed", 0.3], speed: 1.25 },
      { from: ["turnListed", 0.3], to: "uncommitted", speed: 1.4 },
      { from: "uncommitted", to: ["uncommittedListed", 1.9] },
    ],
    camera: [{ at: ["turnEnded", 0.6], look: TOP_OF_CANVAS, zoom: 2.19 }],
    caption: { kicker: "Changes", title: "Even changes outside the project.", at: 0.4, seconds: 4 },
    narration: [{ line: "changes", at: 0.3, musicDipsTo: 0.6 }],
    seconds: 9 * BEAT,
    fadeInFrames: 0,
  },
  {
    kind: "clip",
    id: "terminals",
    clip: "terminals",
    shots: [
      { from: ["shown", -0.3], to: ["logged", 0.3], speed: 2.6 },
      { from: ["logged", 0.3], to: ["diffed", 0.6], speed: 2.9 },
    ],
    camera: [
      { at: ["shown", -0.3], look: "app" },
      { at: ["shown", 0.4], look: "terminals" },
    ],
    caption: { kicker: "Terminals", title: "A shell beside every conversation.", at: 0.3, seconds: 2.8 },
    narration: [{ line: "terminals", at: 0.3, musicDipsTo: 0.6 }],
    seconds: 6 * BEAT,
    fadeInFrames: 0,
  },
  {
    kind: "clip",
    id: "groups",
    clip: "groups",
    shots: [{ from: 0.3, to: ["moved", 0.9], speed: 2.6 }],
    camera: [
      { at: 0.3, look: { x: 0, y: 0, width: 300, height: 520 }, zoom: 1.6 },
      { at: ["grouped", 0.2], look: "app" },
    ],
    caption: { kicker: "Groups", title: "Your projects, in your order.", at: 0.2, seconds: 2.1, side: "right" },
    seconds: 4 * BEAT,
    fadeInFrames: 0,
  },
  flash("flash-show", "show", ["turnEnded", 0.6], "canvas", 1.3),
  flash("flash-ask", "ask", ["picked", 0.1], { x: 846, y: 50, width: 680, height: 400 }, 2),
  flash("flash-tour", "review", ["flowStep", 0.5], { x: 560, y: 90, width: 962, height: 380 }, 1.55),
  flash("flash-posted", "review", ["posted", 0.8], "postedPanel", 2.19),
  flash("flash-changes", "edit", ["uncommittedListed", 1], TOP_OF_CANVAS, 2.19),
  flash("flash-terminals", "terminals", ["diffed", 0.4], "terminals"),
  { kind: "black", id: "silence", seconds: 1, narration: [{ line: "mirador", at: 0.3 }], fadeInFrames: 0 },
  { kind: "end", id: "end", seconds: 5.5, narration: [{ line: "end", at: 0.7 }], fadeInFrames: 0 },
];

/** Where the end card sends people. The repository is private for now, so check this before publishing. */
export const WHERE_TO_GET_IT = "github.com/sodre90/mirador";

/** The music bed; bun run music writes this one. To use another track, put it in public/music and name it here. */
export const MUSIC = "music/score.wav";
