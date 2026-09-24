import { useId, type ComponentProps } from "react";
import { Switch } from "./Switch";

export function PreferenceRow({
  label,
  description,
  id,
  ...props
}: {
  label: string;
  description?: string;
} & Omit<ComponentProps<typeof Switch>, "label" | "aria-label">) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const descriptionId = description ? `${controlId}-description` : undefined;
  return (
    <div data-buzz-ui="" className="buzz-preference-row">
      <div className="buzz-preference-row-content">
        <label className="buzz-preference-row-label" htmlFor={controlId}>
          {label}
        </label>
        {description && (
          <span id={descriptionId} className="buzz-preference-row-description">
            {description}
          </span>
        )}
      </div>
      <Switch
        {...props}
        id={controlId}
        aria-label={label}
        aria-describedby={descriptionId}
      />
    </div>
  );
}
