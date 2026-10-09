import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { BRAND, FONT, MONO } from "../brand.ts";
import { TRANSCRIPT, type TranscriptBlock } from "./wall-transcript.ts";

const COLUMN_WIDTH = 2300;
const COLUMN_GAP = 300;
const COPIES = 8;
const FIRST_LINE_AT = 1150;

function Block({ block }: { block: TranscriptBlock }) {
  if (block.kind === "prose") return <p style={{ margin: "0 0 44px", font: `450 54px/1.5 ${FONT}`, color: "#dcdaf0" }}>{block.text}</p>;
  if (block.kind === "tool")
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 26, margin: "0 0 26px", padding: "18px 30px", borderRadius: 18, background: "rgba(255, 255, 255, 0.05)", font: `500 44px ${MONO}`, color: "#c9c6e4" }}>
        <span style={{ width: 22, height: 22, borderRadius: 11, background: "#3ecf7a", flex: "none" }} />
        <span style={{ color: BRAND.ink, fontWeight: 700 }}>{block.name}</span>
        <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{block.target}</span>
      </div>
    );
  return (
    <div style={{ margin: "0 0 40px", borderRadius: 18, overflow: "hidden", font: `400 42px/1.6 ${MONO}` }}>
      {block.lines.map((line) => (
        <div key={line} style={{ padding: "0 30px", whiteSpace: "pre", overflow: "hidden", color: line.startsWith("+") ? "#9be8b4" : line.startsWith("-") ? "#ffaaa0" : "#bdbad6", background: line.startsWith("+") ? "rgba(62, 207, 122, 0.12)" : line.startsWith("-") ? "rgba(255, 107, 90, 0.12)" : "rgba(255, 255, 255, 0.03)" }}>
          {line}
        </div>
      ))}
    </div>
  );
}

function Column({ x, scrolled }: { x: number; scrolled: number }) {
  return (
    <div style={{ position: "absolute", left: x, top: 0, width: COLUMN_WIDTH, transform: `translateY(${FIRST_LINE_AT - scrolled}px)` }}>
      {Array.from({ length: COPIES }, (_, copy) => TRANSCRIPT.map((block, index) => <Block key={`${copy} ${index}`} block={block} />))}
    </div>
  );
}

/**
 * An agent's answer scrolling past faster and faster, until the camera pulls back and it is a wall: the problem the
 * trailer opens on. The neighbouring columns start further along, so the wall doesn't repeat itself side by side.
 */
export function TextWallScene() {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const seconds = frame / fps;
  const scrolled = 130 * seconds + 330 * seconds ** 2;
  const zoom = interpolate(seconds, [4.6, 7.4], [1, 0.34], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.cubic) });
  const neighbours = interpolate(zoom, [0.8, 1], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const speedPerFrame = (130 + 660 * seconds) / fps;
  const blur = Math.min(4, Math.max(0, (speedPerFrame * zoom - 40) / 25));
  const centreX = (width - COLUMN_WIDTH) / 2;
  const fadeIn = interpolate(frame, [0, 12], [0, 1], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ background: "radial-gradient(120% 90% at 50% 40%, #16142a 0%, #0b0a12 60%, #060509 100%)", opacity: fadeIn }}>
      <AbsoluteFill style={{ transform: `scale(${zoom})`, transformOrigin: "50% 50%", filter: blur > 0.2 ? `blur(${blur}px)` : undefined }}>
        <Column x={centreX} scrolled={scrolled} />
        {[-2, -1, 1, 2].map((offset) => (
          <div key={offset} style={{ opacity: neighbours }}>
            <Column x={centreX + offset * (COLUMN_WIDTH + COLUMN_GAP)} scrolled={scrolled + 1900 * (offset + 3)} />
          </div>
        ))}
      </AbsoluteFill>
      <AbsoluteFill style={{ background: "linear-gradient(#0b0a12 0%, transparent 18%, transparent 80%, #0b0a12 100%)" }} />
    </AbsoluteFill>
  );
}
