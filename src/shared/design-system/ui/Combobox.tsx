import { Combobox as BaseCombobox } from "@base-ui/react/combobox";
import { useId, type ComponentProps, type ReactNode } from "react";
import { CaretDownIcon, CircleNotchIcon } from "../icons";
import { IconButton } from "./IconButton";

/** Shared presentation; callers retain filtering, custom values and async work. */
function Control({
  label,
  triggerLabel,
  loading = false,
  onBrowse,
  id,
  ...props
}: Omit<ComponentProps<typeof BaseCombobox.Input>, "className" | "render"> & {
  label: string;
  triggerLabel: string;
  loading?: boolean;
  onBrowse?: () => void;
}) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  return (
    <div data-buzz-ui="" className="buzz-field">
      <label htmlFor={inputId} className="buzz-field-label">
        {label}
      </label>
      <div className="buzz-combobox-control" aria-busy={loading || undefined}>
        <BaseCombobox.Input
          {...props}
          id={inputId}
          data-buzz-ui=""
          className="buzz-input"
        />
        <span className="buzz-combobox-trigger">
          <BaseCombobox.Trigger
            tabIndex={0}
            onClick={onBrowse}
            render={
              <IconButton
                aria-label={triggerLabel}
                size="compact"
                icon={
                  loading ? (
                    <CircleNotchIcon
                      size={16}
                      className="motion-safe:animate-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <CaretDownIcon size={16} aria-hidden="true" />
                  )
                }
              />
            }
          />
        </span>
      </div>
    </div>
  );
}

function Popup({ children, empty }: { children: ReactNode; empty: ReactNode }) {
  return (
    <BaseCombobox.Portal>
      <BaseCombobox.Positioner
        sideOffset={4}
        className="buzz-select-positioner"
      >
        <BaseCombobox.Popup
          data-buzz-ui=""
          className="buzz-select-popup text-body"
          data-variant="field"
        >
          <BaseCombobox.Empty className="buzz-combobox-empty">
            {empty}
          </BaseCombobox.Empty>
          {children}
        </BaseCombobox.Popup>
      </BaseCombobox.Positioner>
    </BaseCombobox.Portal>
  );
}

function Item({
  children,
  description,
  ...props
}: Omit<ComponentProps<typeof BaseCombobox.Item>, "className" | "render"> & {
  description?: ReactNode;
}) {
  return (
    <BaseCombobox.Item
      {...props}
      className="buzz-select-option buzz-combobox-option"
    >
      <span>{children}</span>
      {description && (
        <span className="text-body-sm text-subtle">{description}</span>
      )}
    </BaseCombobox.Item>
  );
}

export const Combobox = {
  Root: BaseCombobox.Root,
  Control,
  Popup,
  List: BaseCombobox.List,
  Item,
};
