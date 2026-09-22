import { Tabs } from "../../shared/design-system/ui/Tabs";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  SmileyIcon,
  SmileyStickerIcon,
} from "../../shared/design-system/icons/index";
import {
  Popover,
  type PopoverActions,
} from "../../shared/design-system/ui/Popover";
import type { RelaySession } from "../../features/relay/session";
import {
  communityFromScope,
  gifMarkdown,
  relaySupportsKlipy,
} from "../../features/relay/gifs";
import styles from "./Emoji.module.css";
import { GifPicker } from "./GifPicker";

const EMOJI_SIZE = 36;
const EMOJI_SLOT = 48;
const PICKER_COLUMN_CHROME = 44;
// Two balanced scrollbar lanes plus five gaps between six fixed-size slots.
const PICKER_CHROME = 72;

/** Reusable composer picker; data/signing remain owned by the community session. */
export function EmojiPicker({
  session,
  scope,
  disabled,
  insert,
  reaction = false,
}: {
  session: RelaySession;
  scope: string;
  disabled: boolean;
  insert(value: string): void;
  reaction?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"emoji" | "gifs">("emoji");
  const [gifAvailability, setGifAvailability] = useState<{
    community: string;
    supported: boolean | undefined;
  }>();
  const [gifDiscoveryRequested, setGifDiscoveryRequested] = useState(false);
  const [perLine, setPerLine] = useState(0);
  const [error, setError] = useState<string>();
  const [attempt, retry] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const popoverActions = useRef<PopoverActions>(null);
  const controls = useRef<HTMLFieldSetElement>(null);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const search = useRef("");
  const onInsert = useRef(insert);
  onInsert.current = insert;
  const community = reaction ? undefined : communityFromScope(scope);
  const gifs = community
    ? gifAvailability?.community === community
      ? gifAvailability.supported
      : undefined
    : false;
  const showGifTab = gifs === true;
  const catalog = useSyncExternalStore(
    session.emoji.subscribe,
    session.emoji.snapshot,
    session.emoji.snapshot,
  );
  useLayoutEffect(() => {
    // The popover is positioned against the composer; intermediate tool groups
    // may be narrower and are not its available width.
    // Size before paint so opening never flashes a one-column shell.
    const container = reaction
      ? document.documentElement
      : controls.current?.offsetParent;
    if (!open || disabled || !(container instanceof HTMLElement)) return;
    const resize = () =>
      setPerLine(
        Math.max(
          1,
          Math.min(
            6,
            Math.floor(
              (container.clientWidth - PICKER_COLUMN_CHROME) / EMOJI_SLOT,
            ),
          ),
        ),
      );
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    return () => observer.disconnect();
  }, [open, disabled, reaction]);
  useEffect(() => {
    if (
      !community ||
      !gifDiscoveryRequested ||
      (gifAvailability?.community === community &&
        gifAvailability.supported !== undefined)
    )
      return;
    const controller = new AbortController();
    void relaySupportsKlipy(community, controller.signal).then(
      (supported) => {
        if (!controller.signal.aborted) {
          setGifAvailability({ community, supported });
          if (!supported) {
            setTab("emoji");
          }
        }
      },
      () => {
        if (!controller.signal.aborted) {
          setGifAvailability({ community, supported: undefined });
          setGifDiscoveryRequested(false);

          setTab("emoji");
        }
      },
    );
    return () => controller.abort();
  }, [community, gifDiscoveryRequested, gifAvailability]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly retries a failed lazy import.
  useLayoutEffect(() => {
    if (!open || disabled || tab !== "emoji" || !host || !perLine) return;
    const container = host;
    let cancelled = false;
    let dispose: (() => void) | undefined;
    setError(undefined);
    // Keep the Unicode dataset and search work out of startup/channel opening.
    void import("./emoji-mart")
      .then(({ mountEmojiMart }) => {
        if (cancelled) return;
        dispose = mountEmojiMart({
          host: container,
          scope,
          perLine,
          emojiSize: EMOJI_SIZE,
          emojiButtonSize: EMOJI_SLOT,
          search: search.current,
          searchChange: (value) => {
            search.current = value;
          },
          entries: catalog.status === "ready" ? catalog.entries : [],
          media: session.media,
          select: (value) => {
            onInsert.current(value);
            setOpen(false);
          },
          close: () => setOpen(false),
        });
      })
      .catch((reason: unknown) => {
        if (!cancelled)
          setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
      search.current =
        container
          .querySelector("em-emoji-picker")
          ?.shadowRoot?.querySelector<HTMLInputElement>('input[type="search"]')
          ?.value ?? search.current;
      dispose?.();
    };
  }, [open, disabled, session, scope, catalog, attempt, perLine, tab, host]);
  const emojiContent = (
    <div className={styles.emojiMart}>
      <div ref={setHost} />
    </div>
  );
  const gifContent = community && (
    <GifPicker
      community={community}
      initialQuery={search.current}
      onQueryChange={(value) => {
        search.current = value;
      }}
      select={(gif) => {
        onInsert.current(gifMarkdown(gif));
        setOpen(false);

        setTab("emoji");
      }}
    />
  );
  const picker = (
    <Popover.Popup
      variant="flush"
      initialFocus={false}
      onKeyDownCapture={(event) => {
        // Mart swallows Escape in its shadow root before Base UI can see it.
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          popoverActions.current?.close();
        }
      }}
      className={styles.emojiPopover}
      data-reaction={reaction || undefined}
      aria-label="Emoji picker"
      data-tabs={showGifTab || undefined}
      style={{ width: perLine * EMOJI_SLOT + PICKER_CHROME + 2 }}
    >
      <Tabs
        variant="panel"
        label="Media type"
        value={tab}
        onValueChange={setTab}
        items={[
          { value: "emoji", label: "Emoji" },
          ...(showGifTab ? [{ value: "gifs" as const, label: "GIF" }] : []),
        ]}
        renderPanel={(value) => (value === "emoji" ? emojiContent : gifContent)}
      />
      {tab === "emoji" && error && (
        <div role="alert" className={styles.emojiStatus}>
          Could not load emoji picker: {error}
          <Button type="button" onClick={() => retry(attempt + 1)}>
            Retry picker
          </Button>
        </div>
      )}
      {tab === "emoji" && catalog.error && (
        <div className={styles.emojiStatus}>
          <p role="alert">{catalog.error}</p>
          <Button type="button" onClick={() => void session.emoji.refresh()}>
            Retry emoji
          </Button>
        </div>
      )}
    </Popover.Popup>
  );
  const button = (
    <IconButton
      size="toolbar"
      ref={trigger}
      type="button"
      aria-label={reaction ? "Add reaction" : "Insert emoji"}
      title={reaction ? "Add reaction" : "Insert emoji"}
      aria-busy={(gifDiscoveryRequested && gifs === undefined) || undefined}
      disabled={disabled}
      onPointerEnter={() => setGifDiscoveryRequested(true)}
      onFocus={() => setGifDiscoveryRequested(true)}
      icon={
        reaction ? (
          <SmileyStickerIcon size={18} aria-hidden="true" />
        ) : (
          <SmileyIcon size={20} aria-hidden="true" />
        )
      }
    />
  );
  const controlsView = (
    <fieldset
      ref={controls}
      disabled={disabled}
      aria-label="Emoji controls"
      className={styles.emojiPicker}
    >
      <Popover.Trigger render={button} />
      <Popover.Portal>
        <Popover.Positioner
          side={reaction ? "bottom" : "top"}
          anchor={
            reaction
              ? undefined
              : () => controls.current?.closest("form") ?? trigger.current
          }
        >
          {picker}
        </Popover.Positioner>
      </Popover.Portal>
    </fieldset>
  );
  return (
    <Popover.Root
      actionsRef={popoverActions}
      open={open && !disabled}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) return;
        void session.emoji.ensure();
        if (gifs !== true && gifAvailability?.community === community)
          setGifAvailability(undefined);
        setGifDiscoveryRequested(true);
      }}
    >
      {controlsView}
    </Popover.Root>
  );
}
