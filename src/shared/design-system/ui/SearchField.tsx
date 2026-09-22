import { Field } from "@base-ui/react/field";
import { Input } from "@base-ui/react/input";
import { MagnifyingGlassIcon, XIcon } from "../icons/index";
import { useRef, type ComponentProps, type Ref } from "react";
import { IconButton } from "./IconButton";

export function SearchField({
  value,
  onValueChange,
  label = "Search",
  placeholder = "Search",
  variant = "default",
  inputRef,
  ...inputProps
}: {
  inputRef?: Ref<HTMLElement>;
  value: string;
  onValueChange: (value: string) => void;
  label?: string;
  placeholder?: string;
  /** Both variants share the capsule search treatment. */
  variant?: "default" | "navigator";
} & Omit<
  ComponentProps<typeof Input>,
  "value" | "onValueChange" | "className" | "ref" | "render" | "type"
>) {
  const localRef = useRef<HTMLElement | null>(null);
  return (
    <Field.Root data-buzz-ui="" className="search-field" data-variant={variant}>
      <Field.Label className="sr-only">{label}</Field.Label>
      <MagnifyingGlassIcon size={16} aria-hidden="true" />
      <Input
        {...inputProps}
        ref={(node) => {
          localRef.current = node;
          if (typeof inputRef === "function") return inputRef(node);
          if (inputRef) inputRef.current = node;
        }}
        type="search"
        value={value}
        onValueChange={onValueChange}
        placeholder={placeholder}
      />
      {value ? (
        <IconButton
          data-search-clear=""
          aria-label={`Clear ${label.toLowerCase()}`}
          icon={<XIcon size={16} aria-hidden="true" />}
          size="compact"
          disabled={inputProps.disabled || inputProps.readOnly}
          onClick={() => {
            onValueChange("");
            localRef.current?.focus();
          }}
        />
      ) : null}
    </Field.Root>
  );
}
