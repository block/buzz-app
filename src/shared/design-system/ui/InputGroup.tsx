import type { ReactNode, ComponentProps } from "react";

/** Shared frame for SearchField and Combobox; the native control keeps focus. */
export function InputGroup({
  children,
  leading,
  trailing,
  shape = "control",
  ...props
}: Omit<ComponentProps<"div">, "className"> & {
  children?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  shape?: "control" | "panel";
}) {
  return (
    <div
      {...props}
      data-buzz-ui=""
      className="buzz-input-group"
      data-shape={shape}
    >
      {leading && <span className="buzz-input-leading">{leading}</span>}
      {children}
      {trailing !== undefined && (
        <span className="buzz-input-trailing">{trailing}</span>
      )}
    </div>
  );
}
