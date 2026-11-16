// Hands plugins the host's own controls. Each wrapper forwards only the props in
// `contract.ts`, so plugins (usually plain JS) cannot come to depend on internal
// variants or on Base UI's event details.
import { type RefObject, useRef } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Switch } from "../../shared/design-system/ui/Switch";
import type {
  PluginButtonProps,
  PluginDialogProps,
  PluginFieldProps,
  PluginInputProps,
  PluginSwitchProps,
  PluginUi,
} from "./contract";

const tabbable =
  'input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/**
 * Plugins cannot pass a focus ref, so start where a form dialog should: on the
 * first body control, else the first action, never on header Close. The title
 * anchor finds this dialog's popup without exposing its ref.
 */
function initialFocus(anchor: RefObject<HTMLSpanElement | null>) {
  return () => {
    const popup = anchor.current?.closest('[role="dialog"]');
    const first = (region: string) =>
      popup?.querySelector(region)?.querySelector<HTMLElement>(tabbable);
    return first(".buzz-dialog-body") ?? first(".buzz-dialog-actions") ?? true;
  };
}

/** An unsupported value falls back to the default instead of an internal style. */
function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  return allowed.find((option) => option === value);
}

/**
 * Provided as a plain frozen object, not a Cordis `Service`: a service proxies
 * each function it returns anew, and a component type that changes identity on
 * every read would remount on every render. Keys are the public names; the
 * registry marks the same set `pluginApi: "v1"`.
 */
export const pluginUi: PluginUi = Object.freeze({
  Button: ({ children, onClick, ...props }: PluginButtonProps) => (
    <Button
      variant={
        oneOf(props.variant, ["prominent", "subtle", "ghost", "destructive"]) ??
        "subtle"
      }
      size={oneOf(props.size, ["sm", "md"]) ?? "md"}
      loading={props.loading === true}
      disabled={props.disabled === true}
      type={oneOf(props.type, ["button", "submit", "reset"]) ?? "button"}
      form={typeof props.form === "string" ? props.form : undefined}
      onClick={onClick && (() => onClick())}
      title={props.title}
      aria-label={props["aria-label"]}
    >
      {children}
    </Button>
  ),
  Input: ({ onValueChange, ...props }: PluginInputProps) => (
    <Input
      value={props.value}
      defaultValue={props.defaultValue}
      onValueChange={onValueChange && ((value) => onValueChange(value))}
      type={oneOf(props.type, ["text", "email", "url", "password"])}
      placeholder={props.placeholder}
      name={props.name}
      id={props.id}
      disabled={props.disabled}
      readOnly={props.readOnly}
      required={props.required}
      maxLength={props.maxLength}
      aria-label={props["aria-label"]}
    />
  ),
  Field: (props: PluginFieldProps) => (
    <Field
      label={props.label}
      description={props.description}
      error={props.error}
      optional={props.optional === true}
    >
      {props.children}
    </Field>
  ),
  Switch: ({ onCheckedChange, ...props }: PluginSwitchProps) => {
    const shared = {
      checked: props.checked,
      defaultChecked: props.defaultChecked,
      onCheckedChange:
        onCheckedChange && ((checked: boolean) => onCheckedChange(checked)),
      disabled: props.disabled,
      name: props.name,
      id: props.id,
    };
    return props.label === undefined ? (
      <Switch {...shared} aria-label={props["aria-label"] ?? ""} />
    ) : (
      <Switch {...shared} label={props.label} />
    );
  },
  Dialog: function PluginDialog(props: PluginDialogProps) {
    const anchor = useRef<HTMLSpanElement>(null);
    return (
      <Dialog
        open={props.open}
        onOpenChange={props.onOpenChange}
        title={<span ref={anchor}>{props.title}</span>}
        initialFocus={initialFocus(anchor)}
        description={props.description}
        actions={props.actions}
        size={oneOf(props.size, ["compact", "default"]) ?? "default"}
        dismissOnOutsideClick={props.dismissOnOutsideClick !== false}
        preventClose={props.preventClose === true}
      >
        {props.children}
      </Dialog>
    );
  },
});
