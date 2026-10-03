import { pastelLabels, type Pastel } from "../shared/model.ts";
import { pastels, pastelVariables } from "./pastels.ts";

/** The pastels a workspace or a machine can take, and No colour; the one chosen takes the focus. */
export function ColorSwatches({ label, chosen, onChoose }: { label: string; chosen: Pastel | null; onChoose: (color: Pastel | null) => void }) {
  return (
    <div className="color-swatches" role="radiogroup" aria-label={label}>
      {[null, ...pastels].map((color) => (
        <button
          key={color ?? "none"}
          type="button"
          role="radio"
          aria-checked={chosen === color}
          aria-label={color ? pastelLabels[color] : "No colour"}
          className={color ? "swatch" : "swatch no-color"}
          style={color ? pastelVariables(color) : undefined}
          autoFocus={chosen === color}
          onClick={() => onChoose(color)}
        />
      ))}
    </div>
  );
}
