import { Field } from "@base-ui/react/field";
import { Input } from "@base-ui/react/input";
import { MagnifyingGlassIcon, XIcon } from "../icons/index";
import { IconButton } from "./IconButton";

export function SearchField({
  value,
  onValueChange,
  label = "Search",
  placeholder = "Search",
  variant = "default",
}: {
  value: string;
  onValueChange: (value: string) => void;
  label?: string;
  placeholder?: string;
  /** Navigator search uses the panel's broad corner to echo its enclosing surface. */
  variant?: "default" | "navigator";
}) {
  return (
    <Field.Root data-buzz-ui="" className="search-field" data-variant={variant}>
      <Field.Label className="sr-only">{label}</Field.Label>
      <MagnifyingGlassIcon size={16} aria-hidden="true" />
      <Input
        type="search"
        value={value}
        onValueChange={onValueChange}
        placeholder={placeholder}
      />
      {value ? (
        <IconButton
          aria-label={`Clear ${label.toLowerCase()}`}
          icon={<XIcon size={14} aria-hidden="true" />}
          size="compact"
          onClick={() => onValueChange("")}
        />
      ) : null}
    </Field.Root>
  );
}
