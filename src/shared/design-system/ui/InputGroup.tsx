import type { ReactNode, ComponentProps } from "react";

/** Shared frame for SearchField and Combobox; the native control keeps focus. */
export function InputGroup({
  children,
  leading,
  trailing,
  ...props
}: Omit<ComponentProps<"div">, "className"> & {
  children?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <div {...props} data-buzz-ui="" className="buzz-input-group">
      {leading && <span className="buzz-input-leading">{leading}</span>}
      {children}
      {trailing !== undefined && (
        <span className="buzz-input-trailing">{trailing}</span>
      )}
    </div>
  );
}
