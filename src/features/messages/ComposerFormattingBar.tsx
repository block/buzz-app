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
  onFormat,
  onClose,
}: {
  disabled?: boolean;
  onFormat(format: ComposerFormat): void;
  onClose(): void;
}) {
  return (
    <fieldset className="composer-formatting-bar" aria-label="Formatting">
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
          icon={<Icon size={16} aria-hidden="true" />}
          size="toolbar"
          variant="ghost"
          disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onFormat(format)}
        />
      ))}
    </fieldset>
  );
}
