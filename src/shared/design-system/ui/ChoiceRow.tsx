import type { ReactNode } from "react";

/** Row content only. Menu/Select/Combobox owns selection and keyboard behavior.
 * Keep leading and trailing content non-interactive; the parent is the one action. */
export function ChoiceRow({
  label,
  description,
  leading,
  trailing,
}: {
  label: ReactNode;
  description?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <span data-buzz-ui="" className="buzz-choice-row">
      {leading && (
        <span className="buzz-choice-row-leading" aria-hidden="true">
          {leading}
        </span>
      )}
      <span className="buzz-choice-row-content">
        <span className="buzz-choice-row-label">{label}</span>
        {description && (
          <>
            {" "}
            <span className="buzz-choice-row-description text-body-sm">
              {description}
            </span>
          </>
        )}
      </span>
      {trailing && (
        <>
          {" "}
          <span className="buzz-choice-row-trailing text-caption">
            {trailing}
          </span>
        </>
      )}
    </span>
  );
}
