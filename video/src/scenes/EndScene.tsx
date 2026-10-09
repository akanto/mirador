import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { BRAND, FONT, MONO } from "../brand.ts";
import { AppIcon } from "../components/AppIcon.tsx";
import { Backdrop } from "../components/Backdrop.tsx";
import { Reveal } from "../components/Reveal.tsx";

/**
 * The last word, landing on the hit after a breath: the name, the promise and what it saves you, what it runs with
 * and on, and where to get it. Each line comes in as the narrator says it.
 */
export function EndScene({ frames, url }: { frames: number; url: string }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const fadeOut = interpolate(frame, [frames - 30, frames], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const landed = spring({ frame, fps, config: { damping: 18, mass: 0.7 } });
  return (
    <AbsoluteFill style={{ opacity: fadeOut }}>
      <Backdrop />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", fontFamily: FONT }}>
        <div style={{ display: "flex", alignItems: "center", gap: 60, transform: `scale(${1.14 - 0.14 * landed})` }}>
          <AppIcon size={300} />
          <div style={{ font: `780 200px ${FONT}`, letterSpacing: "-0.04em", color: BRAND.ink }}>Mirador</div>
        </div>
        <Reveal at={60} style={{ marginTop: 80 }}>
          <div style={{ fontSize: 124, fontWeight: 740, letterSpacing: "-0.03em", color: BRAND.ink }}>
            See what your coding agent{" "}
            <span style={{ background: `linear-gradient(90deg, ${BRAND.violet}, ${BRAND.coral})`, WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent" }}>means.</span>
          </div>
        </Reveal>
        <Reveal at={175} style={{ marginTop: 34 }}>
          <div style={{ fontSize: 84, fontWeight: 620, letterSpacing: "-0.02em", color: "#cfcde8" }}>Understand it at a glance.</div>
        </Reveal>
        <Reveal at={225} style={{ marginTop: 90, display: "flex", gap: 70, fontSize: 60, fontWeight: 550, color: BRAND.muted }}>
          <span>Claude Code · opencode</span>
          <span style={{ opacity: 0.45 }}>|</span>
          <span>macOS · Linux · Android</span>
        </Reveal>
        <Reveal at={245} style={{ marginTop: 80 }}>
          <div style={{ padding: "26px 60px", borderRadius: 999, border: `3px solid ${BRAND.violet}`, background: "rgba(118, 118, 242, 0.12)", font: `500 64px ${MONO}`, color: BRAND.ink }}>{url}</div>
        </Reveal>
      </AbsoluteFill>
      <AbsoluteFill style={{ background: "#fff", opacity: interpolate(frame, [0, 10], [0.3, 0], { extrapolateRight: "clamp" }) }} />
    </AbsoluteFill>
  );
}
