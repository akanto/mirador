import { useState } from "react";

export type PulseStyle = "smooth" | "stepped" | "off";

const STORAGE_KEY = "mirador-pulses";

export function storedPulsesOn(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

/**
 * Linux's WebKitGTK draws every frame of an animation and its window copies each one on the CPU, while macOS and
 * Windows hand an opacity animation to the system compositor. So on Linux the pulses change a few times a cycle.
 */
export function pulseStyleFor(on: boolean, userAgent: string): PulseStyle {
  if (!on) return "off";
  return /Linux/.test(userAgent) && !/Android/.test(userAgent) ? "stepped" : "smooth";
}

/** The stylesheet steps or stops the status pulses by the root element's data-pulses. */
export function applyPulses(on: boolean) {
  document.documentElement.dataset.pulses = pulseStyleFor(on, navigator.userAgent);
}

export function usePulsesOn() {
  const [on, setOn] = useState(storedPulsesOn);
  const choose = (next: boolean) => {
    applyPulses(next);
    setOn(next);
    try {
      localStorage.setItem(STORAGE_KEY, next ? "on" : "off");
    } catch {}
  };
  return [on, choose] as const;
}
