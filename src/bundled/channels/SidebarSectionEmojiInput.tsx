import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { RelaySession } from "../../features/relay/session";
import { CUSTOM_REACTION } from "../../features/relay/emoji";
import { EmojiPicker } from "../emoji/EmojiPicker";
import { SmileyIcon } from "../../shared/design-system/icons";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { InputGroup } from "../../shared/design-system/ui/InputGroup";
import { SidebarGroupIcon } from "./SidebarGroupIcon";
import styles from "./SidebarSectionEmojiInput.module.css";
import iconStyles from "./SidebarGroupIcon.module.css";

type Session = Pick<RelaySession, "emoji" | "media">;

/** The section forms share one emoji trigger, picker, and independent clear action. */
export function SidebarSectionEmojiInput({
  children,
  session,
  scope,
  icon,
  onIconChange,
  disabled = false,
}: {
  children: ReactNode;
  session: Session;
  scope: string;
  icon: string;
  onIconChange: (icon: string) => void;
  disabled?: boolean;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLDivElement>(null);
  const pickerId = `section-emoji-${useId()}`;
  const close = useCallback(() => setPickerOpen(false), []);
  useEffect(() => {
    if (disabled) close();
  }, [disabled, close]);
  const selection = CUSTOM_REACTION.exec(icon)?.[1] ?? icon;
  const label = icon
    ? `Change section emoji, currently ${selection}`
    : "Choose section emoji";
  return (
    <>
      <InputGroup
        ref={field}
        leading={
          <IconButton
            ref={trigger}
            type="button"
            size="sm"
            aria-label={label}
            aria-haspopup="dialog"
            aria-expanded={pickerOpen && !disabled}
            aria-controls={pickerOpen && !disabled ? pickerId : undefined}
            disabled={disabled}
            onClick={() => {
              if (pickerOpen) return close();
              void session.emoji.ensure("foreground");
              setPickerOpen(true);
            }}
            icon={
              icon ? (
                <span className={styles.icon}>
                  {icon.startsWith(":") && icon.endsWith(":") ? (
                    <SidebarGroupIcon icon={icon} session={session} />
                  ) : (
                    <SectionUnicodeEmoji icon={icon} />
                  )}
                </span>
              ) : (
                <SmileyIcon size={18} aria-hidden="true" />
              )
            }
          />
        }
      >
        {children}
      </InputGroup>
      {pickerOpen && !disabled && (
        <EmojiPicker
          session={session}
          scope={scope}
          disabled={disabled}
          insert={onIconChange}
          reaction
          externalTrigger={{
            ref: trigger,
            anchor: field,
            side: "bottom",
            remove: icon ? () => onIconChange("") : undefined,
            id: pickerId,
            close,
            finalFocus: () =>
              trigger.current?.isConnected && !trigger.current.disabled
                ? trigger.current
                : false,
          }}
        />
      )}
    </>
  );
}

/** Only the form trigger needs ink centering against a circle; keep native text. */
function SectionUnicodeEmoji({ icon }: { icon: string }) {
  const element = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const node = element.current;
    if (!node) return;
    let active = true;
    let measured = "";
    const center = () => {
      if (!active) return;
      const style = getComputedStyle(node);
      const dpr = window.devicePixelRatio || 1;
      const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const key = `${font}\n${style.letterSpacing}\n${dpr}`;
      if (key === measured) return;
      measured = key;
      const offset = horizontalInkOffset(icon, style, font, dpr);
      node.style.transform = `translateX(${offset}px)`;
    };
    const fontsChanged = () => {
      measured = "";
      center();
    };
    // Text scaling changes the span's layout; transforms do not retrigger it.
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(center);
    observer?.observe(node);
    let resolution: MediaQueryList | undefined;
    const watchResolution = () => {
      resolution?.removeEventListener("change", watchResolution);
      resolution = window.matchMedia?.(
        `(resolution: ${window.devicePixelRatio || 1}dppx)`,
      );
      resolution?.addEventListener("change", watchResolution);
      center();
    };
    watchResolution();
    window.addEventListener("resize", center);
    document.fonts?.addEventListener("loadingdone", fontsChanged);
    void document.fonts?.ready.then(() => {
      if (active) fontsChanged();
    });
    return () => {
      active = false;
      observer?.disconnect();
      resolution?.removeEventListener("change", watchResolution);
      window.removeEventListener("resize", center);
      document.fonts?.removeEventListener("loadingdone", fontsChanged);
    };
  }, [icon]);
  return (
    <span
      className={iconStyles.icon}
      aria-hidden="true"
      data-sidebar-group-icon=""
    >
      <span ref={element} className={styles.unicode}>
        {icon}
      </span>
    </span>
  );
}

function horizontalInkOffset(
  icon: string,
  style: CSSStyleDeclaration,
  font: string,
  dpr: number,
) {
  const size = Number.parseFloat(style.fontSize);
  if (!(size > 0)) return 0;
  try {
    // Probe at the displayed size/density: color emoji bearings vary with both.
    // This is measurement only, never a raster replacement for the DOM text.
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return 0;
    context.font = font;
    context.letterSpacing = style.letterSpacing;
    const width = Math.ceil((context.measureText(icon).width + 2 * size) * dpr);
    const height = Math.ceil(3 * size * dpr);
    // Keep a malformed/oversized saved value from allocating a large bitmap.
    if (width > 1024 || height > 1024 || width < 1 || height < 1) return 0;
    canvas.width = width;
    canvas.height = height;
    context.scale(dpr, dpr);
    context.font = font;
    context.letterSpacing = style.letterSpacing;
    context.textAlign = "center";
    context.textBaseline = "alphabetic";
    context.fillText(icon, width / dpr / 2, 2 * size);
    const pixels = context.getImageData(0, 0, width, height).data;
    let left = width;
    let right = -1;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if ((pixels[(y * width + x) * 4 + 3] ?? 0) >= 32) {
          left = Math.min(left, x);
          right = Math.max(right, x);
        }
      }
    }
    return right < 0 ? 0 : (width / 2 - (left + right + 1) / 2) / dpr;
  } catch {
    // Canvas/pixel access may be unavailable; retain advance/grid centering.
    return 0;
  }
}
