import { useLayoutEffect, useReducer, useRef } from "react";
import type { RichComposerAdapter } from "./rich-composer-adapter";
import {
  CodeIcon,
  LinkIcon,
  ListBulletsIcon,
  ListNumbersIcon,
  QuotesIcon,
  TextBIcon,
  TextItalicIcon,
  TextStrikethroughIcon,
  XIcon,
} from "../../shared/design-system/icons/index";
import { IconButton } from "../../shared/design-system/ui/IconButton";

export type ComposerFormat =
  | "bold"
  | "italic"
  | "strike"
  | "code"
  | "quote"
  | "bullet"
  | "number"
  | "link";

const commands = [
  { format: "bold", label: "Bold", icon: TextBIcon },
  { format: "italic", label: "Italic", icon: TextItalicIcon },
  { format: "strike", label: "Strikethrough", icon: TextStrikethroughIcon },
  { format: "code", label: "Code", icon: CodeIcon },
  { format: "quote", label: "Quote", icon: QuotesIcon },
  { format: "bullet", label: "Bulleted list", icon: ListBulletsIcon },
  { format: "number", label: "Numbered list", icon: ListNumbersIcon },
  { format: "link", label: "Link", icon: LinkIcon },
] as const;

export function ComposerFormattingBar({
  disabled,
  owner,
  focusOnMount,
  onFormat,
  onClose,
}: {
  disabled?: boolean;
  owner: RichComposerAdapter | undefined;
  focusOnMount: boolean;
  onFormat(format: ComposerFormat): void;
  onClose(): void;
}) {
  const bar = useRef<HTMLFieldSetElement>(null);
  const [, refresh] = useReducer((value: number) => value + 1, 0);
  useLayoutEffect(() => {
    const stop = owner?.subscribe(() => refresh());
    return () => {
      stop?.();
    };
  }, [owner]);
  useLayoutEffect(() => {
    if (focusOnMount) bar.current?.querySelector("button")?.focus();
  }, [focusOnMount]);
  const activeName = {
    quote: "blockquote",
    bullet: "bulletList",
    number: "orderedList",
  };
  const isActive = (format: ComposerFormat) =>
    format !== "link" &&
    !!owner?.editor.isActive(
      format in activeName
        ? activeName[format as keyof typeof activeName]
        : format,
    );
  return (
    <fieldset
      ref={bar}
      className="composer-formatting-bar"
      aria-label="Formatting"
    >
      <IconButton
        aria-label="Close formatting"
        icon={<XIcon size={16} aria-hidden="true" />}
        size="toolbar"
        variant="ghost"
        onClick={onClose}
      />
      <span className="composer-formatting-divider" aria-hidden="true" />
      {commands.map(({ format, label, icon: Icon }) => (
        <IconButton
          key={format}
          aria-label={label}
          aria-pressed={format === "link" ? undefined : isActive(format)}
          icon={<Icon size={16} aria-hidden="true" />}
          size="toolbar"
          variant={isActive(format) ? "tint" : "ghost"}
          disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onFormat(format)}
        />
      ))}
    </fieldset>
  );
}
