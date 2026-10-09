# The Mirador trailer

A 90-second trailer at 4K and 60 fps, made from footage of a real Mirador: a throwaway host on a fake home folder,
running the real Claude Code against a scripted stand-in for the model. Nothing in it is mocked up by hand, and no
account, conversation or setting of yours is used.

```bash
cd video
bun install
bun run build      # films, encodes, narrates, scores and renders: out/mirador-trailer.mp4
```

It needs Google Chrome, ffmpeg, [uv](https://docs.astral.sh/uv/) and about 3 GB of free disk while it films. The
whole build takes about 10 minutes on an M-series Mac.

## The stages

| Step | Command | What it does |
| --- | --- | --- |
| Film | `bun run capture` | `capture/trailer.spec.ts` starts Mirador on port 5900 with the demo projects in `capture/demo-world.ts`, and films each scene in a 4K Chrome window at 250% zoom. The agents' answers come from `capture/scenes.ts`, through the fake model in `capture/director.ts`. Each scene becomes `public/clips/<scene>.frames` and `<scene>.json`, with the moments and boxes the edit uses. |
| Encode | `bun run encode` | Turns the frames into 60 fps videos at the speed they were filmed, and deletes the frames. |
| Narrate | `bun run narrate` | Speaks `narration/lines.ts` with [Kokoro](https://github.com/thewh1teagle/kokoro-onnx), on this machine, into `public/narration`. Only changed lines are spoken again. The model is downloaded once to `~/.cache/mirador-video` and checked against its hash. |
| Score | `bun run music` | Synthesises the score into `public/music/score.wav` (`audio/compose.ts`), timed to the storyboard. |
| Render | `bun run render` | Renders the [Remotion](https://www.remotion.dev) composition in `src` to `out/render.mp4`, then `audio/master.ts` brings its sound to YouTube's loudness (-14 LUFS) in `out/mirador-trailer.mp4`. |

`bun run studio` opens the composition in Remotion's editor, to scrub through it. `bun run test` checks the timing and
camera logic, and that the storyboard speaks every line.

## Changing it

- **A scene's cut, camera or caption**: `src/storyboard.ts`. Shots, camera moves and captions are keyed to the moments the
  capture marked, such as `["sent", 0.2]`, so they stay right when the footage is filmed again. A scene's `seconds` sets
  its length, and `fadeInFrames: 0` cuts straight to it instead of crossfading; the score puts a hit on such a cut. A
  line of narration's `musicDipsTo` makes the music dip less under it, and the wall's `statement` puts words over it.
- **What the agents say and draw**: `capture/scenes.ts`, then film again.
- **The narration**: edit `narration/lines.ts` and run `bun run narrate`. The render stops with an error while the
  spoken lines don't match the text.
- **The voice**: `bun run narrate --samples` speaks a line in eight voices into `out/voice-samples`. Set `VOICE` in
  `narration/lines.ts` (or `MIRADOR_VIDEO_VOICE`) and narrate again.
- **The music**: put a track in `public/music` and name it in `MUSIC` in `src/storyboard.ts`. It plays under the whole
  trailer and dips while the narrator speaks; `bun run music` would then no longer be needed.
- **The end card's address**: `WHERE_TO_GET_IT` in `src/storyboard.ts`.
- **Light theme**: `MIRADOR_VIDEO_THEME=light bun run capture` films the app in its light theme. The trailer has only been
  made in the dark one so far.
