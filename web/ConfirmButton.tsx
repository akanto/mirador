import { useEffect, useState, type ReactNode } from "react";

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
  children,
}: {
  className: string;
  label: string;
  hint?: string;
  armedText: string;
  armedHint: string;
  onConfirm: () => void;
  children: ReactNode;
}) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const disarm = setTimeout(() => setArmed(false), DISARM_AFTER_MS);
    return () => clearTimeout(disarm);
  }, [armed]);

  return (
    <button
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
      onKeyDown={(event) => event.key === "Escape" && setArmed(false)}
    >
      {armed ? armedText : children}
    </button>
  );
}
