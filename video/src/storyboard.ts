import type { Scene } from "./timeline.ts";

/**
 * The trailer, scene by scene. A clip scene plays stretches of a filmed clip (capture/trailer.spec.ts films them) and
 * moves the camera to boxes the capture measured, at moments it named; a scene lasts at least as long as its lines of
 * narration (narration/lines.ts). To show a new feature: film it as a clip, add its line, add a scene here.
 */
export const STORYBOARD: Scene[] = [
  {
    kind: "text-wall",
    id: "wall",
    seconds: 12,
    narration: [
      { line: "wall", at: 0.3 },
      { line: "wallOfText", at: 6.4 },
      { line: "humans", at: 8 },
    ],
    statement: { text: "Humans see faster than they read.", at: 8.1 },
  },
  { kind: "logo", id: "logo", seconds: 3.8, narration: [{ line: "canvas", at: 0.8 }] },
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
      { from: "flow", to: "findings", speed: 1.5 },
      { from: "findings", to: "askOpened", speed: 1.2 },
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
      { line: "reviewAsk", at: 12.6 },
      { line: "reviewPost", at: 21.2 },
    ],
  },
  {
    kind: "clip",
    id: "edit",
    clip: "edit",
    shots: [
      { from: ["approval", -0.4], to: ["allowed", 0.3], speed: 1.4 },
      { from: ["allowed", 0.3], to: "changes", speed: 3 },
      { from: "changes", to: ["diff", 1.6], speed: 1.1 },
    ],
    camera: [{ at: ["approval", -0.4], look: "app" }],
    caption: { kicker: "Approve", title: "Every edit, with its diff.", at: 0.5, seconds: 3 },
    narration: [{ line: "edit", at: 0.9, musicDipsTo: 0.6 }],
    seconds: 7.5,
    fadeInFrames: 0,
  },
  {
    kind: "clip",
    id: "terminals",
    clip: "terminals",
    shots: [
      { from: ["shown", -0.3], to: ["logged", 0.3], speed: 1.9 },
      { from: ["logged", 0.3], to: ["diffed", 0.6], speed: 2.4 },
    ],
    camera: [
      { at: ["shown", -0.3], look: "app" },
      { at: ["shown", 0.4], look: "terminals" },
    ],
    caption: { kicker: "Terminals", title: "A shell beside every conversation.", at: 0.5, seconds: 3 },
    narration: [{ line: "terminals", at: 0.9, musicDipsTo: 0.6 }],
    seconds: 5,
    fadeInFrames: 0,
  },
  {
    kind: "clip",
    id: "groups",
    clip: "groups",
    shots: [{ from: 0.3, to: ["moved", 0.9], speed: 1.35 }],
    camera: [
      { at: 0.3, look: { x: 0, y: 0, width: 300, height: 520 }, zoom: 1.6 },
      { at: ["grouped", 0.2], look: "app" },
    ],
    caption: { kicker: "Groups", title: "Your projects, in your order.", at: 0.4, seconds: 3, side: "right" },
    seconds: 5,
    fadeInFrames: 0,
  },
  { kind: "end", id: "end", seconds: 6.6, narration: [{ line: "end", at: 0.9 }] },
];

/** Where the end card sends people. The repository is private for now, so check this before publishing. */
export const WHERE_TO_GET_IT = "github.com/sodre90/mirador";

/** The music bed; bun run music writes this one. To use another track, put it in public/music and name it here. */
export const MUSIC = "music/score.wav";
