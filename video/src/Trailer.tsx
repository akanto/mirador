import { Audio } from "@remotion/media";
import { AbsoluteFill, interpolate, Sequence, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { ClipSceneView } from "./scenes/ClipSceneView.tsx";
import { EndScene } from "./scenes/EndScene.tsx";
import { LogoScene } from "./scenes/LogoScene.tsx";
import { TextWallScene } from "./scenes/TextWallScene.tsx";
import { MUSIC, WHERE_TO_GET_IT } from "./storyboard.ts";
import type { ClipInfo, NarrationLine, PlacedScene, Scene } from "./timeline.ts";

export type TrailerProps = {
  placed: PlacedScene[];
  clips: Record<string, ClipInfo>;
  narration: Record<string, NarrationLine>;
};

/** A scene that fades in over the one before it, or cuts straight to it. */
function FadeIn({ children, frames }: { children: React.ReactNode; frames: number }) {
  const frame = useCurrentFrame();
  const opacity = frames === 0 ? 1 : interpolate(frame, [0, frames], [0, 1], { extrapolateRight: "clamp" });
  return <AbsoluteFill style={{ opacity }}>{children}</AbsoluteFill>;
}

function SceneView({ scene, clips, frames }: { scene: Scene; clips: Record<string, ClipInfo>; frames: number }) {
  if (scene.kind === "clip") return <ClipSceneView scene={scene} clip={clips[scene.clip]!} frames={frames} />;
  if (scene.kind === "text-wall") return <TextWallScene />;
  if (scene.kind === "logo") return <LogoScene frames={frames} />;
  return <EndScene frames={frames} url={WHERE_TO_GET_IT} />;
}

const MUSIC_VOLUME = 0.5;
/** How far the music dips while the narrator speaks. */
const DUCKED = 0.2;
const DUCK_RAMP_SECONDS = 0.25;

/** The music's volume at a frame: lower from just before each line of narration until just after it. */
function musicVolume(frame: number, spoken: { from: number; to: number }[], fps: number) {
  const ramp = DUCK_RAMP_SECONDS * fps;
  const ducking = Math.max(0, ...spoken.map(({ from, to }) => interpolate(frame, [from - ramp, from, to, to + ramp], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })));
  return MUSIC_VOLUME * interpolate(ducking, [0, 1], [1, DUCKED]);
}

export function Trailer({ placed, clips, narration }: TrailerProps) {
  const { fps } = useVideoConfig();
  const spoken = placed.flatMap(({ scene, from }) =>
    (scene.narration ?? []).map(({ line, at }) => ({ from: from + (at - 0.15) * fps, to: from + (at + narration[line]!.seconds + 0.2) * fps })),
  );
  return (
    <AbsoluteFill style={{ background: "#08070f" }}>
      {placed.map(({ scene, from, frames, fadeInFrames }) => (
        <Sequence key={scene.id} from={from} durationInFrames={frames} name={scene.id}>
          <FadeIn frames={fadeInFrames}>
            <SceneView scene={scene} clips={clips} frames={frames} />
          </FadeIn>
        </Sequence>
      ))}
      <Audio src={staticFile(MUSIC)} volume={(frame) => musicVolume(frame, spoken, fps)} />
      {placed.flatMap(({ scene, from }) =>
        (scene.narration ?? []).map(({ line, at }) => (
          <Sequence key={`narration ${line}`} from={from + Math.round(at * fps)} name={`narration: ${line}`}>
            <Audio src={staticFile(`narration/${narration[line]!.file}`)} />
          </Sequence>
        )),
      )}
    </AbsoluteFill>
  );
}
