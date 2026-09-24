import type { ReactNode } from "react";

/** Layout only. The caller supplies the control and its accessible name. */
export function SettingRow({
  title,
  description,
  controlId,
  children,
}: {
  title: string;
  description?: ReactNode;
  controlId?: string;
  children: ReactNode;
}) {
  return (
    <div data-buzz-ui="" className="buzz-setting-row">
      <div className="buzz-setting-row-copy">
        <label className="buzz-setting-row-title" htmlFor={controlId}>
          {title}
        </label>
        {description && (
          <div className="buzz-setting-row-description">{description}</div>
        )}
      </div>
      <div className="buzz-setting-row-control">{children}</div>
    </div>
  );
}
