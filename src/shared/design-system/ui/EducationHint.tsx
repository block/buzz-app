import {
  useRef,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react";
import { XIcon } from "../icons/index";
import { IconButton } from "./IconButton";
import { PreviewCard } from "./PreviewCard";

/** What EducationHint needs from the host's Seen service. */
export type SeenStore = {
  has(key: string): boolean | undefined;
  mark(key: string): void;
  subscribe(listener: () => void): () => void;
};

const never = () => () => {};

/** True only once Seen has answered that this moment has not happened. */
export function useUnseen(seen: SeenStore | undefined, key: string) {
  return (
    useSyncExternalStore(seen?.subscribe ?? never, () => seen?.has(key)) ===
    false
  );
}

/**
 * A one-time tip about a feature, opened by hovering or focusing the control it
 * explains. It stays available until the person dismisses it, which Seen
 * remembers; using the feature does not dismiss it. Without Seen, or once
 * seen, only the control renders.
 */
export function EducationHint({
  seen,
  seenKey,
  children,
  content,
  side = "bottom",
}: {
  seen: SeenStore | undefined;
  /** `<plugin-id>/<name>`; a new key shows an updated tip again. */
  seenKey: string;
  /** The one control the tip explains. */
  children: ReactElement;
  content: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
}) {
  const unseen = useUnseen(seen, seenKey);
  const action = useRef<HTMLButtonElement>(null);
  if (!unseen) return children;
  return (
    <PreviewCard
      trigger={children}
      side={side}
      align="center"
      actionRef={action}
      tone="inverse"
      aria-label="Tip"
    >
      <span className="buzz-education-hint">
        <span>{content}</span>
        <IconButton
          ref={action}
          aria-label="Dismiss tip"
          icon={<XIcon />}
          variant="bare"
          size="text"
          onClick={() => seen?.mark(seenKey)}
        />
      </span>
    </PreviewCard>
  );
}
