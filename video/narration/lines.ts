/**
 * What the narrator says; the storyboard puts each line in a scene, at a second. Change a line here, run
 * bun run narrate, and only that line is spoken again.
 */
export const LINES = {
  wall: "Coding agents are fast. In minutes, they read your code, change ten files, and explain it all...",
  wallOfText: "in a wall of text.",
  canvas: "Mirador gives your agent a canvas.",
  show: "So instead of describing, it shows you. Flows, architecture, mockups and charts, drawn right beside the conversation.",
  ask: "When a decision is yours, it asks with pictures. Click an option, and it carries on.",
  review: "Reviews become a guided tour of the change, in the order the code runs, with findings pinned to the lines they're about.",
  reviewAsk: "Question a finding, and the agent answers and rewrites it in place.",
  overview: "Run your agents across all your projects. See who's working, who's done, and who needs you.",
  edit: "Approve every edit with its diff.",
  terminals: "Your terminals sit right beside the conversation.",
  end: "Mirador. See what your coding agent means.",
} as const;

export type LineName = keyof typeof LINES;

/** Kokoro's voice and pace. Hear the others with bun run narrate --samples. */
export const VOICE = process.env.MIRADOR_VIDEO_VOICE ?? "am_fenrir";
export const SPEED = 1;

/** The voices bun run narrate --samples speaks a line in, to pick from. */
export const SAMPLE_VOICES = ["af_heart", "af_bella", "af_nicole", "bf_emma", "am_michael", "am_fenrir", "bm_george", "bm_fable"];
