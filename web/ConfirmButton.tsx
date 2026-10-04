import { useEffect, useRef, useState, type ReactNode } from "react";

const DISARM_AFTER_MS = 4_000;

/**
 * A destructive button that asks again in place: the first click arms it, a second click within a few
 * seconds acts. Used instead of confirm(), which the desktop app's web view does not reliably show.
 */
export function ConfirmButton({
  className,
  label,
  hint,
  armedText,
  armedHint,
  onConfirm,
  armRequest,
  children,
}: {
  className: string;
  label: string;
  hint?: string;
  armedText: string;
  armedHint: string;
  onConfirm: () => void;
  /** Each new request arms it and gives it the focus, so Enter confirms, e.g. after ⌘W met a terminal running a command. */
  armRequest?: object | null;
  children: ReactNode;
}) {
  const [armed, setArmed] = useState(false);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!armRequest) return;
    setArmed(true);
    button.current?.focus();
  }, [armRequest]);

  useEffect(() => {
    if (!armed) return;
    const disarm = setTimeout(() => setArmed(false), DISARM_AFTER_MS);
    return () => clearTimeout(disarm);
  }, [armed]);

  return (
    <button
      ref={button}
      type="button"
      className={armed ? `${className} armed` : className}
      aria-label={armed ? `Confirm: ${label}` : label}
      data-hint={armed ? armedHint : hint}
      onClick={(event) => {
        event.stopPropagation();
        setArmed(!armed);
        if (armed) onConfirm();
      }}
      onBlur={() => setArmed(false)}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !armed) return;
        event.preventDefault();
        setArmed(false);
      }}
    >
      {armed ? armedText : children}
    </button>
  );
}
