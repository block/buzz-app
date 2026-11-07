import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import type { ChannelMessage } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import type {
  ContributionReader,
  MessageTextSelection,
  SelectionPreview,
  SelectionPreviewProps,
  TargetOpener,
} from "../conversation/contracts";
import { useConversationPresentation } from "../conversation/ConversationPresentation";
import { selectionPreviews } from "../conversation/selection-preview";
import {
  ContributionBoundary,
  contributionKey,
} from "../conversation/ContributionBoundary";
import { WithTargetOpener } from "../conversation/opener";
import {
  behindActiveOverlay,
  observeOverlays,
} from "../../shared/design-system/overlayLayer";
import {
  PopoverRoot,
  PopoverPopup,
  PopoverTitle,
} from "../../shared/design-system/ui/Popover";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { ChoiceRow } from "../../shared/design-system/ui/ChoiceRow";
import {
  XIcon,
  CaretLeftIcon,
  CaretRightIcon,
} from "../../shared/design-system/icons";
import { messageViewKey } from "./view-key";

type Props = {
  list: RefObject<HTMLElement | null>;
  rows: readonly ChannelMessage[];
  session: RelaySession;
  scope: string;
  channelId: string;
  threadRootId?: string | undefined;
  registry?: ContributionReader<SelectionPreview> | undefined;
  active?: boolean | undefined;
};
type Selected = MessageTextSelection & { range: Range; element: HTMLElement };
const unavailable =
  'input, textarea, select, button, [contenteditable]:not([contenteditable="false"]), [inert], [hidden], [aria-hidden="true"]';
const elementOf = (node: Node) =>
  node instanceof Element ? node : node.parentElement;

/** Internal DOM boundary only. Plugin authors receive text and a message, never a live Range. */
export function selectedMessageText(
  list: HTMLElement,
  rows: readonly ChannelMessage[],
): Selected | undefined {
  const selection = list.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return;
  const range = selection.getRangeAt(0);
  const start = elementOf(range.startContainer);
  const end = elementOf(range.endContainer);
  if (!start || !end || start.closest(unavailable) || end.closest(unavailable))
    return;
  const body = start.closest<HTMLElement>("[data-message-action-anchor]");
  if (
    !body ||
    !list.contains(body) ||
    body.closest("[data-message-scroller]") !== list ||
    end.closest("[data-message-action-anchor]") !== body
  )
    return;
  const element = body.closest<HTMLElement>("[data-message-id]");
  const message = rows.find((row) => row.id === element?.dataset.messageId);
  const text = selection.toString();
  if (!element || !message || !text.trim() || text.length > 4096) return;
  return { text, message, range: range.cloneRange(), element };
}
function sameSelection(a: Selected | undefined, b: Selected | undefined) {
  return (
    a === b ||
    !!(
      a &&
      b &&
      a.message === b.message &&
      a.text === b.text &&
      a.element === b.element &&
      a.range.startContainer === b.range.startContainer &&
      a.range.startOffset === b.range.startOffset &&
      a.range.endContainer === b.range.endContainer &&
      a.range.endOffset === b.range.endOffset
    )
  );
}
const empty = Object.freeze([]);
const noEntries = () => empty;
const noSubscribe = () => () => {};

/** No listeners or popup when no enabled plugin contributes. */
export function SelectionPreviews(props: Props) {
  const active = useConversationPresentation();
  const entries = useSyncExternalStore(
    props.registry?.subscribe ?? noSubscribe,
    props.registry?.snapshot ?? noEntries,
    props.registry?.snapshot ?? noEntries,
  );
  return active &&
    props.active !== false &&
    props.registry &&
    entries.length ? (
    <SelectionHost
      key={messageViewKey(
        props.session,
        props.scope,
        props.channelId,
        props.threadRootId,
      )}
      {...props}
      registry={props.registry}
    />
  ) : null;
}
function SelectionHost({
  list,
  rows,
  session,
  channelId,
  registry,
}: Props & { registry: ContributionReader<SelectionPreview> }) {
  const entries = useSyncExternalStore(
    registry.subscribe,
    registry.snapshot,
    registry.snapshot,
  );
  const [selected, setSelected] = useState<Selected>();
  const [chosen, setChosen] = useState<{
    selection: Selected;
    entry: (typeof entries)[number];
  }>();
  const dismissed = useRef<Selected>(undefined);
  const popup = useRef<HTMLDivElement>(null);
  const usedPopup = useRef(false);
  const currentRows = useRef(rows);
  currentRows.current = rows;
  const close = () => {
    setSelected((current) => {
      if (current !== selected) return current;
      dismissed.current = current;
      return undefined;
    });
  };
  useEffect(() => {
    const owner = list.current;
    if (!owner) return;
    const document = owner.ownerDocument;
    const window = document.defaultView;
    if (!window) return;
    let pressed = false;
    let frame = 0;
    const read = () => {
      frame = 0;
      if (behindActiveOverlay(owner, popup.current)) {
        setSelected(undefined);
        return;
      }
      // Plugin fields may take focus without losing the immutable selection snapshot.
      if (popup.current?.contains(document.activeElement) && !pressed) {
        usedPopup.current = true;
        return;
      }
      // Switching a focused chooser button unmounts it and may collapse the
      // browser selection. Keep the captured text until the next outside gesture.
      if (usedPopup.current && !pressed && document.getSelection()?.isCollapsed)
        return;
      const next =
        !pressed && !behindActiveOverlay(owner, popup.current)
          ? selectedMessageText(owner, currentRows.current)
          : undefined;
      if (!next && !pressed && document.getSelection()?.isCollapsed)
        dismissed.current = undefined;
      const visible = sameSelection(next, dismissed.current) ? undefined : next;
      setSelected((previous) =>
        sameSelection(previous, visible) ? previous : visible,
      );
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(read);
    };
    const press = (event: PointerEvent) => {
      if (popup.current?.contains(event.target as Node)) return;
      pressed = true;
      usedPopup.current = false;
      const outside = !owner.contains(event.target as Node);
      dismissed.current = outside
        ? selectedMessageText(owner, currentRows.current)
        : undefined;
      setSelected(undefined);
      setChosen(undefined);
    };
    const release = () => {
      pressed = false;
      schedule();
    };
    const key = (event: KeyboardEvent) => {
      if (
        event.shiftKey ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.isComposing ||
        event.keyCode === 229 ||
        event.defaultPrevented ||
        !popup.current ||
        (
          popup.current.closest("[data-base-ui-portal]") ?? popup.current
        ).contains(event.target as Node) ||
        behindActiveOverlay(owner, popup.current)
      )
        return;
      if (event.key === "Tab") {
        // There is no trigger button: native focus stays in the selected text.
        // The host header/chooser always starts with an enabled button.
        event.preventDefault();
        event.stopPropagation();
        popup.current.querySelector<HTMLButtonElement>("button")?.focus();
      } else if (event.key === "Escape") {
        // Automatic opening retains history focus. Consume Escape before its
        // containing thread/tab can close; focused popup widgets own their keys.
        event.preventDefault();
        event.stopPropagation();
        const current = selectedMessageText(owner, currentRows.current);
        if (current) dismissed.current = current;
        setSelected(undefined);
      }
    };
    const stopOverlays = observeOverlays(schedule);
    const selectionChanged = () => {
      if (document.getSelection()?.isCollapsed) dismissed.current = undefined;
      schedule();
    };
    document.addEventListener("selectionchange", selectionChanged);
    document.addEventListener("pointerdown", press, true);
    document.addEventListener("pointerup", release, true);
    document.addEventListener("pointercancel", release, true);
    document.addEventListener("keydown", key, true);
    // Dismiss on scroll instead of retaining a preview over a virtualized-away row.
    const scroll = () => {
      const current = selectedMessageText(owner, currentRows.current);
      if (current) dismissed.current = current;
      setSelected(undefined);
    };
    owner.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", scroll);
    schedule();
    return () => {
      window.cancelAnimationFrame(frame);
      stopOverlays();
      document.removeEventListener("selectionchange", selectionChanged);
      document.removeEventListener("pointerdown", press, true);
      document.removeEventListener("pointerup", release, true);
      document.removeEventListener("pointercancel", release, true);
      document.removeEventListener("keydown", key, true);
      owner.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", scroll);
    };
  }, [list]);
  // Edits, removal and target changes revoke the previous message snapshot immediately.
  const valid =
    selected?.element.isConnected &&
    selected.message.channelId === channelId &&
    rows.includes(selected.message);
  const snapshot = valid
    ? Object.freeze({ text: selected.text, message: selected.message })
    : undefined;
  const matches = snapshot ? selectionPreviews(entries, snapshot) : [];
  const preview =
    chosen && chosen.selection === selected && matches.includes(chosen.entry)
      ? chosen.entry
      : matches.length === 1
        ? matches[0]
        : undefined;
  if (!valid || !snapshot || !matches.length) return null;
  return (
    <PopoverRoot
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <PopoverPopup
        ref={popup}
        size="compact"
        padding="list"
        onFocusCapture={() => {
          usedPopup.current = true;
        }}
        anchor={{
          getBoundingClientRect: () => selected.range.getBoundingClientRect(),
          contextElement: selected.element,
        }}
        initialFocus={false}
        finalFocus={false}
        aria-label="Selected text previews"
      >
        {preview && (
          <div className="flex items-center gap-1 px-2 py-1">
            {matches.length > 1 && (
              <IconButton
                icon={<CaretLeftIcon size={16} />}
                aria-label="Other previews"
                title="Other previews"
                onPointerDown={(event) => event.preventDefault()}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setChosen(undefined)}
              />
            )}
            <div className="min-w-0 flex-1">
              <PopoverTitle>{preview.title}</PopoverTitle>
            </div>
            <IconButton
              icon={<XIcon size={16} />}
              aria-label="Dismiss"
              title="Dismiss"
              onClick={close}
            />
          </div>
        )}
        {preview ? (
          <div className="px-2 pb-2">
            <ContributionBoundary
              key={`${contributionKey(preview)}:${contributionKey(selected)}`}
              fallback={<p className="text-body-sm">Preview unavailable.</p>}
            >
              <OwnedPreview
                preview={preview}
                props={{ ...snapshot, session, close }}
                registry={registry}
              />
            </ContributionBoundary>
          </div>
        ) : (
          matches.map((entry) => (
            <NavigationItem
              key={entry.key}
              title={entry.pluginId}
              multiline={matches.some(
                (other) => other !== entry && other.title === entry.title,
              )}
              label={
                <ChoiceRow
                  label={entry.title}
                  description={
                    matches.some(
                      (other) => other !== entry && other.title === entry.title,
                    )
                      ? entry.pluginId
                      : undefined
                  }
                />
              }
              trailing={<CaretRightIcon size={16} />}
              onPointerDown={(event) => event.preventDefault()}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setChosen({ selection: selected, entry })}
            />
          ))
        )}
      </PopoverPopup>
    </PopoverRoot>
  );
}

/** A retained callback cannot dismiss a replacement plugin or a later selection. */
function OwnedPreview({
  preview,
  props,
  registry,
}: {
  preview: ReturnType<typeof selectionPreviews>[number];
  props: Omit<SelectionPreviewProps, keyof TargetOpener>;
  registry: ContributionReader<SelectionPreview>;
}) {
  const live = useRef(false);
  useLayoutEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  return (
    <WithTargetOpener
      component={preview.component}
      props={{
        ...props,
        close: () => {
          if (live.current && registry.snapshot().includes(preview))
            props.close();
        },
      }}
      registry={registry}
      entry={preview}
    />
  );
}
