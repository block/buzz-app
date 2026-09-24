import { Field } from "./Field";
import { InputGroup } from "./InputGroup";
import { Input } from "@base-ui/react/input";
import { MagnifyingGlassIcon, XIcon } from "../icons/index";
import { useRef, type ComponentProps, type Ref, type ReactNode } from "react";
import { IconButton } from "./IconButton";

export function SearchField({
  value,
  onValueChange,
  label = "Search",
  placeholder = "Search",
  inputRef,
  description,
  error,
  ...inputProps
}: {
  inputRef?: Ref<HTMLElement>;
  description?: ReactNode;
  error?: ReactNode;
  value: string;
  onValueChange: (value: string) => void;
  label?: string;
  placeholder?: string;
} & Omit<
  ComponentProps<typeof Input>,
  "value" | "onValueChange" | "className" | "ref" | "render" | "type"
>) {
  const localRef = useRef<HTMLElement | null>(null);
  return (
    <Field
      label={label}
      labelVisibility="hidden"
      description={description}
      error={error}
    >
      <InputGroup
        leading={<MagnifyingGlassIcon size={16} aria-hidden="true" />}
        trailing={
          value ? (
            <IconButton
              aria-label={`Clear ${label.toLowerCase()}`}
              icon={<XIcon size={16} aria-hidden="true" />}
              size="sm"
              disabled={inputProps.disabled || inputProps.readOnly}
              onClick={() => {
                onValueChange("");
                localRef.current?.focus();
              }}
            />
          ) : null
        }
      >
        <Input
          {...inputProps}
          data-buzz-ui=""
          className="buzz-input"
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
      </InputGroup>
    </Field>
  );
}
