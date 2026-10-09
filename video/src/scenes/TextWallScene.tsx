import type { ReactNode } from "react";
import { AbsoluteFill, Easing, interpolate, interpolateColors, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { BRAND, FONT, FRAME, MONO } from "../brand.ts";
import { statementBeats, type Rect, type WallScene } from "../timeline.ts";
import { TRANSCRIPT, type TranscriptBlock } from "./wall-transcript.ts";

const COLUMN_WIDTH = 2300;
const COLUMN_GAP = 300;
const COPIES = 16;
const FIRST_LINE_AT = 1150;
const NEIGHBOURS = [-3, -2, -1, 1, 2, 3];
const clamped = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

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
 * An agent's answer scrolling past faster and faster, until the camera pulls back on more of it than anyone could read,
 * brighter and shaking as it goes black. The neighbouring columns start further along, so it doesn't repeat side by side.
 */
function Wall({ seconds, goesBlackAt }: { seconds: number; goesBlackAt: number }) {
  const { fps, width } = useVideoConfig();
  const scrolled = 130 * seconds + 330 * seconds ** 2;
  const pullBack = interpolate(seconds, [4.6, 7], [1, 0.36], { ...clamped, easing: Easing.inOut(Easing.cubic) });
  const zoom = pullBack * interpolate(seconds, [7, goesBlackAt], [1, 0.8], clamped);
  const neighbours = interpolate(zoom, [0.8, 1], [1, 0], clamped);
  const speedPerFrame = (130 + 660 * seconds) / fps;
  const blur = Math.min(4, Math.max(0, (speedPerFrame * zoom - 40) / 25));
  const pressure = interpolate(seconds, [goesBlackAt - 1, goesBlackAt], [0, 1], clamped);
  const shake = `translate(${pressure * 26 * Math.sin(seconds * 97)}px, ${pressure * 18 * Math.sin(seconds * 131 + 1)}px)`;
  const centreX = (width - COLUMN_WIDTH) / 2;
  return (
    <AbsoluteFill style={{ background: "radial-gradient(120% 90% at 50% 40%, #16142a 0%, #0b0a12 60%, #060509 100%)", transform: shake }}>
      <AbsoluteFill style={{ transform: `scale(${zoom})`, transformOrigin: "50% 50%", filter: `blur(${blur}px) brightness(${1 + 0.45 * pressure})` }}>
        <Column x={centreX} scrolled={scrolled} />
        {NEIGHBOURS.map((offset) => (
          <div key={offset} style={{ opacity: neighbours }}>
            <Column x={centreX + offset * (COLUMN_WIDTH + COLUMN_GAP)} scrolled={scrolled + 1900 * (offset + 4)} />
          </div>
        ))}
      </AbsoluteFill>
      <AbsoluteFill style={{ background: "linear-gradient(#0b0a12 0%, transparent 18%, transparent 80%, #0b0a12 100%)" }} />
    </AbsoluteFill>
  );
}

const NODES = ["Browser", "Checkout", "Payments", "Orders"];
const NODE = { width: 600, height: 300, gap: 220 };
const ROWS_PER_NODE = 10;
const LINE_COLOURS = ["#dcdaf0", "#9be8b4", "#ffaaa0", "#bdbad6"];
const nodeLeft = (node: number) => FRAME.width / 2 + (node - NODES.length / 2) * (NODE.width + NODE.gap) + NODE.gap / 2;
const nodeTop = (FRAME.height - NODE.height) / 2;

function seededRandom(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/** The wall's lines, each from a place on the screen to a row of one of the picture's boxes. */
const LINES = (() => {
  const random = seededRandom(42);
  return NODES.flatMap((_, node) =>
    Array.from({ length: ROWS_PER_NODE }, (_, row) => {
      const width = 320 + random() * 1080;
      const scattered: Rect = { x: 120 + random() * (FRAME.width - 240 - width), y: 140 + random() * (FRAME.height - 300), width, height: 24 };
      const inBox: Rect = { x: nodeLeft(node), y: nodeTop + (row * NODE.height) / ROWS_PER_NODE, width: NODE.width, height: NODE.height / ROWS_PER_NODE };
      return { scattered, inBox, colour: LINE_COLOURS[Math.floor(random() * LINE_COLOURS.length)]!, delay: random() * 0.35 };
    }),
  );
})();

const between = (from: number, to: number, progress: number) => from + (to - from) * progress;

/** From black, the wall's lines come back scattered, then fly together into four boxes and the arrows between them. */
function Picture({ seconds, pictureAt, dimmed }: { seconds: number; pictureAt: number; dimmed: number }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const appear = interpolate(seconds, [pictureAt, pictureAt + 0.15], [0, 0.9], clamped);
  const boxesShown = interpolate(seconds, [pictureAt + 1.25, pictureAt + 1.55], [0, 1], clamped);
  return (
    <AbsoluteFill style={{ opacity: 1 - 0.72 * dimmed, filter: dimmed > 0 ? `blur(${10 * dimmed}px)` : undefined }}>
      {LINES.map(({ scattered, inBox, colour, delay }, index) => {
        const flown = spring({ frame: frame - (pictureAt + 0.25 + delay) * fps, fps, config: { damping: 16, mass: 0.9, stiffness: 90 } });
        return (
          <div
            key={index}
            style={{
              position: "absolute",
              left: between(scattered.x, inBox.x, flown),
              top: between(scattered.y, inBox.y, flown),
              width: between(scattered.width, inBox.width, flown),
              height: between(scattered.height, inBox.height, flown),
              borderRadius: 12 * (1 - flown),
              background: interpolateColors(flown, [0, 1], [colour, BRAND.violet]),
              opacity: appear,
            }}
          />
        );
      })}
      {NODES.map((name, node) => (
        <div
          key={name}
          style={{
            position: "absolute",
            left: nodeLeft(node),
            top: nodeTop,
            width: NODE.width,
            height: NODE.height,
            borderRadius: 40,
            background: `linear-gradient(160deg, ${BRAND.violet}, ${BRAND.indigo})`,
            boxShadow: `0 0 120px rgba(118, 118, 242, ${0.45 * boxesShown})`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            font: `720 76px ${FONT}`,
            color: BRAND.ink,
            opacity: boxesShown,
          }}
        >
          {name}
        </div>
      ))}
      <svg width={FRAME.width} height={FRAME.height} style={{ position: "absolute", inset: 0 }}>
        {NODES.slice(1).map((name, index) => {
          const drawn = interpolate(seconds, [pictureAt + 1.5 + index * 0.18, pictureAt + 1.8 + index * 0.18], [0, 1], clamped);
          const from = nodeLeft(index) + NODE.width + 28;
          const to = nodeLeft(index + 1) - 28;
          const tip = between(from, to, drawn);
          const middle = FRAME.height / 2;
          return (
            <g key={name} opacity={drawn > 0 ? 1 : 0}>
              <line x1={from} y1={middle} x2={tip - 26} y2={middle} stroke={BRAND.ink} strokeWidth={12} strokeLinecap="round" />
              <polygon points={`${tip},${middle} ${tip - 44},${middle - 26} ${tip - 44},${middle + 26}`} fill={BRAND.ink} />
            </g>
          );
        })}
      </svg>
    </AbsoluteFill>
  );
}

/** A word that lands: big and faint for a frame, then snapping to its place. */
function Landing({ at, children }: { at: number; children: ReactNode }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const since = frame - at * fps;
  const landed = spring({ frame: since, fps, config: { damping: 14, mass: 0.6, stiffness: 180 } });
  return <span style={{ display: "inline-block", whiteSpace: "nowrap", opacity: since < 0 ? 0 : Math.min(1, (since + 1) / 3), transform: `scale(${1.4 - 0.4 * landed})`, transformOrigin: "left center" }}>{children}</span>;
}

const LAST_PART = { background: `linear-gradient(90deg, ${BRAND.violet}, ${BRAND.coral})`, WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent" } as const;

/**
 * The problem the trailer opens on: a wall of text that piles up until it goes black and silent. Out of the black, its
 * lines fly together into a picture, and the statement lands over it, part by part.
 */
export function TextWallScene({ scene }: { scene: WallScene }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const seconds = frame / fps;
  const goesBlackAt = scene.goesBlackAt ?? scene.seconds;
  const fadeIn = interpolate(frame, [0, 12], [0, 1], { extrapolateRight: "clamp" });
  const { statement, pictureAt } = scene;
  const dimmed = statement ? interpolate(seconds, [statement.at - 0.06, statement.at + 0.2], [0, 1], clamped) : 0;
  const beats = statement ? statementBeats(statement) : [];
  return (
    <AbsoluteFill style={{ background: "#000", opacity: fadeIn }}>
      {seconds < goesBlackAt && <Wall seconds={seconds} goesBlackAt={goesBlackAt} />}
      {pictureAt !== undefined && seconds >= pictureAt && <Picture seconds={seconds} pictureAt={pictureAt} dimmed={dimmed} />}
      {statement && (
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
          <div style={{ display: "flex", gap: "0.26em", font: `780 170px ${FONT}`, letterSpacing: "-0.035em", color: BRAND.ink }}>
            {statement.parts.map((part, index) => (
              <Landing key={part} at={beats[index]!}>
                <span style={index === statement.parts.length - 1 ? LAST_PART : undefined}>{part}</span>
              </Landing>
            ))}
          </div>
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
}
