import { AbsoluteFill, Freeze, Sequence, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { FRAME, WINDOW } from "../brand.ts";
import { cameraTransform, viewAt } from "../camera.ts";
import { AppWindow, ClipVideo } from "../components/AppWindow.tsx";
import { Backdrop } from "../components/Backdrop.tsx";
import { CaptionCard } from "../components/CaptionCard.tsx";
import type { ClipInfo, ClipScene } from "../timeline.ts";
import { shotsOf, shotTrim } from "../timeline.ts";

/** A filmed scene: the clip's shots in the app window, the camera moving between its views, and the scene's caption. */
export function ClipSceneView({ scene, clip, frames }: { scene: ClipScene; clip: ClipInfo; frames: number }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const src = staticFile(`clips/${clip.name}.mp4`);
  const shots = shotsOf(scene, clip);
  const footageEnds = Math.round(shots.at(-1)!.sceneTo * fps);
  const last = shots.at(-1)!;
  const camera = cameraTransform(viewAt(scene, clip, frame / fps), WINDOW.app, FRAME, (frame / frames) * 0.025);
  const caption = scene.caption;
  return (
    <AbsoluteFill>
      <Backdrop />
      <AbsoluteFill style={camera}>
        <AppWindow>
          {shots.map((shot) => {
            const from = Math.round(shot.sceneFrom * fps);
            return (
              <Sequence key={from} from={from} durationInFrames={Math.round(shot.sceneTo * fps) - from} layout="none">
                <ClipVideo src={src} {...shotTrim(shot, clip, fps)} playbackRate={shot.speed} />
              </Sequence>
            );
          })}
          {frames > footageEnds && (
            <Sequence from={footageEnds} layout="none">
              <Freeze frame={0}>
                <ClipVideo src={src} trimBefore={Math.round(last.clipTo * fps) - 1} trimAfter={Math.round(last.clipTo * fps)} playbackRate={1} />
              </Freeze>
            </Sequence>
          )}
        </AppWindow>
      </AbsoluteFill>
      {caption && <CaptionCard kicker={caption.kicker} title={caption.title} side={caption.side} from={Math.round((caption.at ?? 0.5) * fps)} to={caption.seconds ? Math.round(((caption.at ?? 0.5) + caption.seconds) * fps) : frames - 12} />}
    </AbsoluteFill>
  );
}
