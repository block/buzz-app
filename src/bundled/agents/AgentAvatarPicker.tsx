import { useMediaCorners } from "../../features/messages/use-media-corners";
import { animatedImage } from "../../features/messages/prepare-attachment";
import { AgentAvatarBackdrop } from "./AgentAvatarBackdrop";
import { EmojiSwap } from "./EmojiSwap";
import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  useSyncExternalStore,
  type Ref,
} from "react";
import {
  avatarMotionAllowed,
  createDockMagnifier,
  swapAvatarArtwork,
} from "./avatar-motion";
import {
  agentAvatars,
  randomAgentAvatar,
} from "../../features/agents/avatar-packs";
import { AvatarEmojiPicker } from "../../features/profiles/AvatarEditor";
import {
  AvatarCropFrame,
  AvatarZoom,
  useAvatarPan,
} from "../../features/profiles/AvatarCrop";
import {
  type AvatarCrop,
  croppedAvatar,
  emojiAvatar,
  emojiAvatarScale,
  avatarCropBox,
  uncropped,
  uploadAvatar,
} from "../../features/profiles/avatar-upload";
import { useAvatarPreview } from "../../features/profiles/use-avatar-preview";
import {
  CircleIcon,
  ImageIcon,
  SmileyIcon,
  XIcon,
} from "../../shared/design-system/icons";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
} from "../../shared/design-system/ui/Popover";
import { SurfaceButton } from "../../shared/design-system/ui/SurfaceButton";
import { OwnedContribution } from "../../plugins/OwnedContribution";
import { ContributionBoundary } from "../../features/conversation/ContributionBoundary";
import type {
  Agents,
  RegisteredAgentAvatarSource,
} from "../../features/agents/service";
import { PackedAgentAvatar } from "./PackedAgentAvatar";
import { avatarSource } from "../../shared/avatar-source";
import styles from "./AgentCreate.module.css";

// Avatar artwork colors: Buzz blue/purple/green/amber plus Tailwind hues.
// These are exported into image pixels, so they stay stable across theme changes.
const backgrounds = [
  "#F43F5E",
  "#EC4899",
  "#D946EF",
  "#8E4EC6",
  "#6366F1",
  "#0090FF",
  "#0EA5E9",
  "#06B6D4",
  "#14B8A6",
  "#30A46C",
  "#22C55E",
  "#84CC16",
  "#F59E0B",
  "#F97316",
  "#EA580C",
  "#EF4444",
  "#FBBF24",
  "#A16207",
  "#334155",
  "#18181B",
  "transparent",
] as const;

type BuiltInSelection =
  | { kind: "gloopie"; picture: string }
  | { kind: "emoji"; emoji: string; color: string; crop?: AvatarCrop }
  | { kind: "image"; picture: string; crop?: AvatarCrop };
export type AvatarSelection =
  | BuiltInSelection
  // A plugin's pick: a displayable `data:` preview and the validated file
  // Save uploads, tied to the exact registration that gave it, never to an id.
  // The host owns both once chosen; the source is never asked again. The
  // choice it replaced returns when that registration goes, unless a Save
  // has started: then `attempt` holds what that Save sends, and where.
  | {
      kind: "source";
      entry: RegisteredAgentAvatarSource;
      picture: string;
      file?: File;
      seed?: string;
      previous: BuiltInSelection;
      attempt?: AvatarAttempt;
      /** Why the source's newest pick failed. Save refuses with it, rather
       * than saving the avatar shown from before, until a pick lands or
       * another avatar is chosen. Present means failed, whatever its text. */
      failed?: { message: string };
    };
/** One Save of a source's pick, frozen at Save start: the preview, upload,
 * retry and the agent write all use it, and only in its community. */
type AvatarAttempt = Readonly<{
  entry: RegisteredAgentAvatarSource;
  file: File;
  picture: string;
  seed?: string;
  community: string;
}>;
type SourceSelection = Extract<AvatarSelection, { kind: "source" }>;

/** The selection to show and save: a registration that is gone gives way to
 * the choice beneath it; a Save that started shows and keeps its attempt. */
export const effectiveAvatar = (
  selection: AvatarSelection,
  sources: readonly RegisteredAgentAvatarSource[],
): AvatarSelection =>
  selection.kind !== "source" ||
  selection.attempt ||
  sources.includes(selection.entry)
    ? selection
    : selection.previous;

type EmojiSelection = Extract<AvatarSelection, { kind: "emoji" }>;

const defaultEmojiColor = backgrounds[0];

/** Plugins' avatar sources, in their stable order. */
export const useAvatarSources = (agents: Agents) =>
  useSyncExternalStore(agents.subscribe, agents.avatarSources);

/** The name a source sees: one spelling for one name, as typed otherwise. */
export const avatarSourceName = (name: string) =>
  name.normalize("NFKC").trim().replace(/\s+/g, " ");

const sourceTab = (key: string) => `source:${key}`;
// A pick must display wherever the draft shows (picker, intro), so it obeys
// the shared avatar parser's inline cap: 512 KiB of base64 text.
const maxPickBytes = 380 * 1024;
const pickError = "Choose a PNG, JPEG, GIF or WebP image under 380 KiB.";
/** How long Save waits for a source's newest pick to arrive and decode. */
export const PICK_WAIT_MS = 8_000;
/** A reason's own text, or `fallback` when it has none worth showing: a
 * blank `Error`, or a rejection with no `Error` at all. */
const reasonText = (reason: unknown, fallback: string) =>
  reason instanceof Error && reason.message.trim() ? reason.message : fallback;
const sourceImage = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.*)$/;
const dataUrl = (image: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(image);
  });
/** A source's pick as a preview every avatar surface displays and the file
 * Save uploads, or why not. No fetch: desktop CSP blocks `data:` there. */
async function sourcePicture(image: unknown) {
  const picture =
    image instanceof Blob
      ? image.size && image.size <= maxPickBytes
        ? await dataUrl(image)
        : ""
      : typeof image === "string"
        ? image
        : "";
  const [, type, base64] = sourceImage.exec(picture) ?? [];
  if (!type || !base64 || !avatarSource(picture) || !(await decodes(picture)))
    throw new Error(pickError);
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  if (bytes.length > maxPickBytes) throw new Error(pickError);
  return { picture, file: new File([bytes], "avatar", { type }) };
}
const validSeed = (seed: unknown): seed is string | undefined =>
  seed === undefined ||
  (typeof seed === "string" && seed.length > 0 && seed.length <= 256);

// The emoji's center stays inside the frame.
const emojiCenter = (value: number) => Math.min(0.5, Math.max(-0.5, value));

/** Whether this browser can paint the image. */
const decodes = (src: string) =>
  Object.assign(new Image(), { src })
    .decode()
    .then(
      () => true,
      () => false,
    );

export function AgentAvatarPicker({
  name,
  selection: draft,
  disabled,
  community,
  sources = [],
  liveSources,
  onChange,
  onBusyChange,
  avatarRef,
}: {
  name: string;
  selection: AvatarSelection;
  disabled: boolean;
  community?: string | undefined;
  /** Plugins' avatar sources, shown as tabs after the built-in ones. */
  sources?: readonly RegisteredAgentAvatarSource[];
  /** The registry's live snapshot, read when a source calls back. */
  liveSources?: () => readonly RegisteredAgentAvatarSource[];
  onChange(selection: AvatarSelection): void;
  onBusyChange(busy: boolean): void;
  /** `prepare` uploads to the community Save captured, never the one shown
   * now, so the avatar and the agent can't land in different communities. */
  avatarRef: Ref<{ prepare(destination: string | undefined): Promise<string> }>;
}) {
  const surfaceCorners = useMediaCorners();
  const filmCorners = useMediaCorners();
  const selection = effectiveAvatar(draft, sources);
  const mode = selection.kind;
  const source =
    selection.kind === "source" && sources.includes(selection.entry)
      ? selection.entry
      : undefined;
  // A Save's attempt whose registration is gone stays, without tab or controls.
  const orphaned = selection.kind === "source" && !source;
  // Each registration's last pick, so returning to its tab restores it. A
  // replacement under the same id is a new registration and starts empty.
  const sourcePicks = useRef(
    new WeakMap<RegisteredAgentAvatarSource, SourceSelection>(),
  );
  const keepPick = (pick: SourceSelection) =>
    sourcePicks.current.set(pick.entry, pick);
  const latest = useRef(selection);
  latest.current = selection;
  /** Marks the source's draft with its newest pick's failure, which every
   * Save refuses with until a pick lands or another avatar is chosen. */
  const markFailed = (entry: RegisteredAgentAvatarSource, message: string) => {
    const now = latest.current;
    if (now.kind !== "source" || now.entry !== entry) return;
    const next = { ...now, failed: { message } };
    keepPick(next);
    latest.current = next;
    onChange(next);
  };
  // Only the newest pick may land: a new pick, a tab change or the end of
  // Save's wait retires every pick still on its way.
  const pickToken = useRef(0);
  // The newest pick still on its way, which Save waits for. Its promise
  // never rejects: it settles with the pick, or with why it can't be used.
  const landing = useRef<
    | {
        entry: RegisteredAgentAvatarSource;
        token: number;
        done: Promise<SourceSelection | Error | undefined>;
        /** Ends the wait at once, as when its source goes. */
        retire(error: Error): void;
      }
    | undefined
  >(undefined);
  // While Save waits, a failed pick is Save's error, shown once by its owner.
  const saveWaiting = useRef(false);
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  const live = () => (liveSources ?? (() => sourcesRef.current))();
  const tabList = useRef<HTMLDivElement>(null);
  const lastFocus = useRef<Element | null>(null);
  const noteFocus = (event: { target: EventTarget | null }) => {
    if (event.target instanceof Element) lastFocus.current = event.target;
  };
  useEffect(() => {
    const tabs = tabList.current;
    const note = (event: FocusEvent) => {
      if (event.target instanceof Element) lastFocus.current = event.target;
    };
    tabs?.addEventListener("focusin", note);
    return () => tabs?.removeEventListener("focusin", note);
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a pick on its way stops when its source goes.
  useEffect(() => {
    const waiting = landing.current;
    if (!waiting || live().includes(waiting.entry)) return;
    pickToken.current += 1;
    landing.current = undefined;
    waiting.retire(
      new Error("This avatar's source is off. Choose another avatar."),
    );
  }, [sources]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a sources change may remove the focused tab or control.
  useEffect(() => {
    // Focus on a tab or control that went away returns to the selected tab.
    const focused = lastFocus.current;
    if (
      !focused ||
      focused.isConnected ||
      (document.activeElement && document.activeElement !== document.body)
    )
      return;
    lastFocus.current = null;
    (
      tabList.current?.querySelector<HTMLElement>(
        '[role="tab"][aria-selected="true"]',
      ) ?? tabList.current?.querySelector<HTMLElement>('[role="tab"]')
    )?.focus();
  }, [sources]);
  const picture = selection.kind === "emoji" ? "" : selection.picture;
  const lastEmoji = useRef<EmojiSelection>({
    kind: "emoji",
    emoji: "😀",
    color: defaultEmojiColor,
  });
  const [animateEmoji, setAnimateEmoji] = useState(false);
  const [animateBackdrop, setAnimateBackdrop] = useState(false);
  const [animateColor, setAnimateColor] = useState(false);
  const emojiSelection =
    selection.kind === "emoji" ? selection : lastEmoji.current;
  const { emoji, color } = emojiSelection;
  const setEmoji = (change: Partial<EmojiSelection>) => {
    lastEmoji.current = { ...emojiSelection, ...change };
    onChange(lastEmoji.current);
  };
  const [emojiOpen, setEmojiOpen] = useState(false);
  // The chosen file shows at once; it stays the artwork after its upload lands.
  type Local = {
    url: string;
    fixed?: boolean;
    picture?: string;
    progress?: number;
  };
  const [local, setLocal] = useState<Local | null>(null);
  // A replacement keeps the framed source until it lands, so a failed or
  // canceled upload restores it.
  const kept = useRef<Local | null>(null);
  // The crop lives in the selection so its owner can tell a reframe is a change.
  const crop =
    (selection.kind !== "gloopie" &&
      selection.kind !== "source" &&
      selection.crop) ||
    uncropped;
  const cropImage = useRef<HTMLImageElement>(null);
  // An image keeps only the framing it shows, so zooming back out restores
  // the original.
  const setCrop = (value: AvatarCrop) => {
    if (selection.kind === "emoji") return setEmoji({ crop: value });
    const image = cropImage.current;
    onChange({
      kind: "image",
      picture,
      crop: image?.naturalWidth
        ? avatarCropBox(image.naturalWidth / image.naturalHeight, value).crop
        : value,
    });
  };
  const uploading = local && local.picture === undefined ? local : null;
  const busy = !!uploading;
  const localUrl = local?.url;
  useEffect(
    () => () => {
      if (localUrl && localUrl !== kept.current?.url)
        URL.revokeObjectURL(localUrl);
    },
    [localUrl],
  );
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const pending = useRef<AbortController | null>(null);
  const selected =
    selection.kind === "gloopie"
      ? agentAvatars.find((avatar) => avatar.url === picture)
      : undefined;
  const [lastAvatar, setLastAvatar] = useState(
    () => selected ?? randomAgentAvatar(),
  );
  // A source that goes before a pick restores the choice beneath, so an
  // unchanged avatar stays unchanged.
  const fallback = draft !== selection ? selection : undefined;
  useEffect(() => {
    if (fallback) onChange(fallback);
  }, [fallback, onChange]);
  const [slots, setSlots] = useState(() =>
    agentAvatars
      .filter((avatar) => avatar.url !== picture)
      .map((avatar) => ({ id: avatar.id, avatar })),
  );
  const center = useRef<HTMLDivElement>(null);
  const swap = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => swap.current?.(), []);
  const dockPointer = useRef<number | null>(null);
  const drag = useRef<{
    pointer: number;
    x: number;
    left: number;
    moved: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const [magnifier] = useState(createDockMagnifier);
  useEffect(() => () => magnifier.dispose(), [magnifier]);
  const resetDock = (dock: HTMLElement) => {
    dockPointer.current = null;
    magnifier.move(dock, null);
  };
  const endDrag = (event: React.PointerEvent<HTMLFieldSetElement>) => {
    if (drag.current?.pointer !== event.pointerId) return;
    drag.current = null;
    delete event.currentTarget.dataset.dragging;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const dockEvents = {
    onPointerDown: (event: React.PointerEvent<HTMLFieldSetElement>) => {
      suppressClick.current = false;
      if (event.pointerType !== "mouse" || event.button !== 0) return;
      const dock = event.currentTarget;
      if (disabled || busy || dock.scrollWidth <= dock.clientWidth) return;
      event.preventDefault();
      drag.current = {
        pointer: event.pointerId,
        x: event.clientX,
        left: dock.scrollLeft,
        moved: false,
      };
    },
    onPointerMove: (event: React.PointerEvent<HTMLFieldSetElement>) => {
      const dock = event.currentTarget;
      const gesture = drag.current;
      if (gesture?.pointer === event.pointerId) {
        if (!event.buttons || disabled || busy) {
          endDrag(event);
          return;
        }
        const distance = event.clientX - gesture.x;
        if (!gesture.moved && Math.abs(distance) < 4) return;
        gesture.moved = true;
        suppressClick.current = true;
        dock.setPointerCapture(event.pointerId);
        dock.dataset.dragging = "true";
        resetDock(dock);
        dock.scrollLeft = gesture.left - distance;
        return;
      }
      const bounds = dock.getBoundingClientRect();
      // The native scrollbar is navigation, not part of the magnification area.
      if (event.clientY >= bounds.top + dock.clientHeight || event.buttons) {
        resetDock(dock);
        return;
      }
      if (
        !disabled &&
        !busy &&
        event.pointerType === "mouse" &&
        avatarMotionAllowed()
      ) {
        dockPointer.current = event.clientX;
        magnifier.move(dock, event.clientX);
      }
    },
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
    onLostPointerCapture: endDrag,
    onClickCapture: (event: React.MouseEvent<HTMLFieldSetElement>) => {
      // A released drag must never choose the avatar underneath it. Keyboard
      // activation has detail 0 and remains available after a drag.
      if (suppressClick.current && event.detail > 0) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    onPointerLeave: (event: React.PointerEvent<HTMLFieldSetElement>) =>
      resetDock(event.currentTarget),
    onKeyDown: (event: React.KeyboardEvent<HTMLFieldSetElement>) => {
      dockPointer.current = null;
      magnifier.move(event.currentTarget, null, true);
    },
    onScroll: (event: React.UIEvent<HTMLFieldSetElement>) =>
      magnifier.move(event.currentTarget, dockPointer.current),
  };
  const dockSurface = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const surface = dockSurface.current;
    if (!surface) return;
    // The dock hides its scrollbar; the dominant axis of any wheel moves it.
    const wheel = (event: WheelEvent) => {
      const dock = surface.querySelector("fieldset");
      if (!dock || event.ctrlKey) return;
      const unit =
        event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? dock.clientWidth
          : event.deltaMode === WheelEvent.DOM_DELTA_LINE
            ? 16
            : 1;
      const delta =
        (Math.abs(event.deltaX) > Math.abs(event.deltaY)
          ? event.deltaX
          : event.deltaY) * unit;
      const room = dock.scrollWidth - dock.clientWidth;
      if (
        !delta ||
        room <= 0 ||
        (delta < 0 && dock.scrollLeft <= 0) ||
        (delta > 0 && dock.scrollLeft >= room)
      )
        return;
      event.preventDefault();
      dock.scrollBy({ left: delta, behavior: "instant" });
    };
    surface.addEventListener("wheel", wheel, { passive: false });
    return () => surface.removeEventListener("wheel", wheel);
  }, []);
  const preview = useAvatarPreview(selected ? "" : picture, community, "small");
  useEffect(
    () => () => {
      pending.current?.abort();
      // A pick that arrives after the picker closes changes nothing.
      pickToken.current += 1;
      landing.current = undefined;
      if (kept.current) URL.revokeObjectURL(kept.current.url);
    },
    [],
  );
  const shown = local?.picture === picture ? local?.url : undefined;
  const cropping = shown && !local?.fixed ? shown : undefined;
  useImperativeHandle(avatarRef, () => ({
    async prepare(destination) {
      const image = cropImage.current;
      const request = new AbortController();
      pending.current = request;
      try {
        // Save is for the pick last made, so a pick still on its way is
        // waited for, briefly; one that fails or never comes refuses Save.
        for (
          let waiting = landing.current;
          waiting &&
          waiting.token === pickToken.current &&
          live().includes(waiting.entry);
          waiting = landing.current
        ) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          saveWaiting.current = true;
          const outcome = await Promise.race([
            waiting.done,
            new Promise<"late">((resolve) => {
              timer = setTimeout(() => resolve("late"), PICK_WAIT_MS);
            }),
          ]).finally(() => {
            clearTimeout(timer);
            saveWaiting.current = false;
          });
          request.signal.throwIfAborted();
          if (outcome === "late") {
            pickToken.current += 1;
            if (landing.current === waiting) landing.current = undefined;
            markFailed(
              waiting.entry,
              `${waiting.entry.title} didn't finish this avatar. Choose it again, then save.`,
            );
          }
          // Its source went while Save waited: there is no tab to choose in.
          if (outcome instanceof Error && !live().includes(waiting.entry))
            throw outcome;
        }
        const selection = latest.current;
        if (selection.kind === "source" && selection.failed !== undefined)
          throw new Error(selection.failed.message);
        // Default framing keeps the original upload.
        if (cropping)
          await image?.decode().catch(() => {
            // Saving the original would silently drop the framing.
            if (crop.zoom !== 1 || crop.x || crop.y)
              throw new Error("Couldn't frame the image. Try again.");
          });
        request.signal.throwIfAborted();
        pickToken.current += 1;
        const framed =
          cropping && image?.naturalWidth
            ? avatarCropBox(image.naturalWidth / image.naturalHeight, crop).crop
            : uncropped;
        // Save sends the attempt made when the first Save began: the source
        // is not called, and a retry sends the same file to the same
        // community, or nowhere.
        if (selection.kind === "source") {
          if (!selection.file)
            throw new Error(`Choose an avatar in ${selection.entry.title}.`);
          if (selection.attempt && selection.attempt.community !== destination)
            throw new Error(
              "This avatar's upload started in another community. Switch back to it to try again, or choose another avatar.",
            );
          if (!destination)
            throw new Error("Select a community to use this avatar.");
          let attempt = selection.attempt;
          if (!attempt) {
            attempt = Object.freeze({
              entry: selection.entry,
              file: selection.file,
              picture: selection.picture,
              ...(selection.seed === undefined ? {} : { seed: selection.seed }),
              community: destination,
            });
            const held = { ...selection, attempt };
            keepPick(held);
            onChange(held);
          }
          return await uploadAvatar(
            attempt.file,
            attempt.community,
            request.signal,
          );
        }
        const paint =
          selection.kind === "emoji"
            ? () =>
                emojiAvatar(
                  selection.emoji,
                  selection.color,
                  emojiAvatarScale * crop.zoom,
                  crop.y,
                  crop.x,
                )
            : image && (framed.zoom !== 1 || framed.x || framed.y)
              ? () => croppedAvatar(image, crop)
              : undefined;
        if (!paint) return selection.kind === "emoji" ? "" : selection.picture;
        if (!destination)
          throw new Error("Select a community to use an emoji avatar.");
        const file = await paint();
        request.signal.throwIfAborted();
        return await uploadAvatar(file, destination, request.signal);
      } finally {
        if (pending.current === request) pending.current = null;
      }
    },
  }));
  const upload = async (file: File) => {
    if (!community || pending.current || disabled) return;
    const request = new AbortController();
    pending.current = request;
    const url = URL.createObjectURL(file);
    kept.current = local;
    setLocal({ url });
    onBusyChange(true);
    setError("");
    try {
      const value = await uploadAvatar(
        file,
        community,
        request.signal,
        (sent, total) => {
          if (!request.signal.aborted && total)
            setLocal({ url, progress: sent / total });
        },
      );
      // Uploads stay as chosen when painting would keep only an animation's
      // first frame, or when this browser can't decode them (HEIC outside
      // WebKit, which the host converts).
      const fixed =
        (await animatedImage(file).catch(() => true)) || !(await decodes(url));
      if (request.signal.aborted) return;
      if (kept.current) URL.revokeObjectURL(kept.current.url);
      kept.current = null;
      setLocal({ url, fixed, picture: value });
      onChange({ kind: "image", picture: value });
    } catch (reason) {
      if (request.signal.aborted) return;
      restore();
      setError(reasonText(reason, "Image upload failed. Try again."));
    } finally {
      if (!request.signal.aborted) {
        pending.current = null;
        onBusyChange(false);
      }
    }
  };
  const restore = () => {
    setLocal(kept.current);
    kept.current = null;
  };
  const cancelUpload = () => {
    pending.current?.abort();
    pending.current = null;
    restore();
    onBusyChange(false);
  };
  const chooseImage = () => {
    if (!community) {
      setError("Select a community to upload an image.");
      return;
    }
    input.current?.click();
  };
  const locked = disabled || busy;
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  const chooseFrom =
    (entry: RegisteredAgentAvatarSource, active: () => boolean) =>
    (image: unknown, seed?: unknown) => {
      // Observed at once, so a promise the host ignores never rejects
      // unhandled.
      const arriving = Promise.resolve(image);
      arriving.catch(() => {});
      if (lockedRef.current || !active()) return;
      const token = ++pickToken.current;
      if (!validSeed(seed)) {
        const message = "That avatar source gave an invalid seed.";
        markFailed(entry, message);
        setError(message);
        return;
      }
      // A pick lands only if it is still the newest and its contribution is
      // live in the registry. Save waits for it, then retires what follows.
      const current = () =>
        token === pickToken.current && active() && live().includes(entry);
      let retire: (error: Error) => void = () => {};
      const retired = new Promise<Error>((resolve) => (retire = resolve));
      const made: Promise<SourceSelection | Error | undefined> = arriving
        .then(sourcePicture)
        .then(
          ({ picture, file }) => {
            const now = latest.current;
            if (!current() || now.kind !== "source" || now.entry !== entry)
              return undefined;
            const next: SourceSelection = {
              kind: "source",
              entry,
              picture,
              file,
              ...(seed === undefined ? {} : { seed }),
              previous: now.previous,
            };
            keepPick(next);
            // Save may read it before the next render.
            latest.current = next;
            setError("");
            onChange(next);
            return next;
          },
          (reason: unknown) => {
            // A retired pick's failure is dropped; it never reaches Save.
            if (!current()) return undefined;
            const failed = new Error(reasonText(reason, pickError));
            markFailed(entry, failed.message);
            if (!saveWaiting.current) setError(failed.message);
            return failed;
          },
        );
      const done = Promise.race([made, retired]).finally(() => {
        if (landing.current?.done === done) landing.current = undefined;
      });
      landing.current = { entry, token, done, retire };
    };
  const emojiPan = useAvatarPan(
    crop,
    (x, y) => setCrop({ ...crop, x: emojiCenter(x), y: emojiCenter(y) }),
    locked,
  );
  return (
    <>
      <div
        ref={surfaceCorners}
        className={styles.avatarSurface}
        data-color-transition={animateColor || undefined}
        style={
          mode === "emoji"
            ? {
                backgroundColor:
                  color === "transparent"
                    ? "var(--surface-panel)"
                    : `color-mix(in srgb, ${color} 14%, var(--surface-panel))`,
              }
            : undefined
        }
      >
        {(busy || mode !== "emoji") && (
          <AgentAvatarBackdrop
            animate={animateBackdrop}
            src={uploading?.url ?? selected?.preview ?? shown ?? preview}
          />
        )}
        <div ref={tabList} className="flex items-center justify-end">
          <Tabs
            label="Avatar type"
            variant="segmented-icons"
            value={
              selection.kind !== "source"
                ? mode
                : source
                  ? sourceTab(source.key)
                  : "attempt"
            }
            items={[
              {
                value: "gloopie",
                label: "Gloopies",
                disabled: locked,
                icon: (
                  <Avatar
                    src={lastAvatar.preview}
                    alt=""
                    fallback={lastAvatar.label}
                    size="fill"
                    shape="squircle"
                  />
                ),
              },
              {
                value: "emoji",
                label: "Emoji",
                icon: <SmileyIcon />,
                disabled: locked,
              },
              {
                value: "image",
                label: "Upload image",
                icon: <ImageIcon />,
                disabled: locked,
              },
              ...sources.map((item) => ({
                value: sourceTab(item.key),
                label: item.title,
                icon: (
                  <ContributionBoundary fallback={null}>
                    {item.icon}
                  </ContributionBoundary>
                ),
                disabled: locked,
              })),
            ]}
            onValueChange={(next) => {
              swap.current?.();
              swap.current = undefined;
              pickToken.current += 1;
              setAnimateBackdrop(false);
              setAnimateColor(false);
              if (next === "image") {
                chooseImage();
                return;
              }
              const picked = sources.find(
                (item) => sourceTab(item.key) === next,
              );
              const previous =
                selection.kind === "source" ? selection.previous : selection;
              onChange(
                picked
                  ? {
                      ...(sourcePicks.current.get(picked) ?? {
                        kind: "source",
                        entry: picked,
                        picture: "",
                      }),
                      previous,
                    }
                  : next === "gloopie"
                    ? { kind: "gloopie", picture: lastAvatar.url }
                    : lastEmoji.current,
              );
              setError("");
            }}
            onReselect={(next) => {
              if (next === "image") chooseImage();
            }}
          />
        </div>
        <input
          ref={input}
          type="file"
          accept="image/*"
          aria-label="Upload an image"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void upload(file);
          }}
        />
        <div className={styles.avatarBrowser}>
          <div className={styles.avatarStage}>
            <div ref={center} className={styles.avatarSelected}>
              {uploading ? (
                <div className={styles.avatarUploading}>
                  <Avatar
                    src={uploading.url}
                    alt="Uploading avatar"
                    fallback={name}
                    size="fill"
                    shape="squircle"
                  />
                  <span className={styles.uploadCancel}>
                    <IconButton
                      variant="glass"
                      shape="round"
                      size="large"
                      aria-label="Cancel upload"
                      icon={
                        <span className={styles.uploadControl}>
                          <svg
                            viewBox="0 0 24 24"
                            role="progressbar"
                            aria-label="Uploading image"
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={
                              uploading.progress === undefined
                                ? undefined
                                : Math.round(uploading.progress * 100)
                            }
                            className={
                              uploading.progress === undefined
                                ? styles.uploadPreparing
                                : undefined
                            }
                          >
                            <circle
                              cx="12"
                              cy="12"
                              r="9"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="3"
                              opacity="0.5"
                            />
                            <circle
                              className={styles.uploadArc}
                              cx="12"
                              cy="12"
                              r="9"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="3"
                              pathLength="100"
                              strokeDasharray={`${uploading.progress === undefined ? 25 : uploading.progress * 100} 100`}
                              transform="rotate(-90 12 12)"
                            />
                          </svg>
                          <XIcon aria-hidden="true" />
                        </span>
                      }
                      onClick={cancelUpload}
                    />
                  </span>
                </div>
              ) : mode === "emoji" ? (
                <PopoverRoot
                  open={emojiOpen}
                  onOpenChange={(open) => {
                    // The click that ends a drag only moves the emoji.
                    if (!open || !emojiPan.moved.current) setEmojiOpen(open);
                  }}
                >
                  <PopoverTrigger
                    render={
                      <SurfaceButton
                        className={styles.emojiAvatarButton}
                        aria-label="Choose emoji"
                        aria-description="Drag or use the arrow keys to move the emoji"
                        disabled={locked}
                        {...emojiPan.handlers}
                      />
                    }
                  >
                    <span
                      data-avatar-shape="squircle"
                      className={styles.emojiAvatarArtwork}
                      style={{ backgroundColor: color }}
                    >
                      <EmojiSwap
                        emoji={emoji}
                        crop={crop}
                        animate={animateEmoji}
                      />
                    </span>
                  </PopoverTrigger>
                  <PopoverPopup
                    aria-label="Choose emoji"
                    onKeyDownCapture={(event) => {
                      // Emoji Mart consumes Escape in its shadow-root search.
                      // Close this popup before the key reaches the widget.
                      if (event.key === "Escape") {
                        event.preventDefault();
                        event.stopPropagation();
                        setEmojiOpen(false);
                      }
                    }}
                    side="bottom"
                    align="start"
                  >
                    <AvatarEmojiPicker
                      disabled={locked}
                      onSelect={(value, animate) => {
                        setAnimateEmoji(animate);
                        setEmoji({ emoji: value });
                        setEmojiOpen(false);
                      }}
                    />
                  </PopoverPopup>
                </PopoverRoot>
              ) : selected ? (
                <PackedAgentAvatar avatar={selected} />
              ) : cropping ? (
                <AvatarCropFrame
                  src={cropping}
                  shape="squircle"
                  crop={crop}
                  disabled={locked}
                  imageRef={cropImage}
                  onChange={setCrop}
                />
              ) : (
                <Avatar
                  src={shown ?? preview}
                  alt="Selected avatar"
                  fallback={name}
                  size="fill"
                  shape="squircle"
                />
              )}
              {/* Floats over the artwork so showing it never moves the card. */}
              {!uploading && (mode === "emoji" || (cropping && !selected)) && (
                <AvatarZoom
                  className={`${styles.avatarZoom} glass-secondary`}
                  crop={crop}
                  disabled={locked}
                  onChange={(value) =>
                    setCrop(
                      selection.kind === "emoji"
                        ? value
                        : // An image zooms about the frame's centre, so the
                          // framed subject stays in place.
                          {
                            ...value,
                            x: (crop.x * value.zoom) / crop.zoom,
                            y: (crop.y * value.zoom) / crop.zoom,
                          },
                    )
                  }
                />
              )}
            </div>
          </div>
          <div ref={dockSurface} className={styles.dockSurface}>
            <div
              ref={filmCorners}
              aria-hidden="true"
              className={`${styles.dockGlass} glass-secondary`}
            />
            {orphaned ? (
              <p
                className={`${styles.avatarDock} m-0 text-body-sm text-secondary`}
              >
                This avatar's source is off. Its picture stays for this Save;
                save again to retry it, or choose another avatar.
              </p>
            ) : source ? (
              <fieldset
                className={styles.avatarDock}
                aria-label={source.title}
                disabled={locked}
                onFocus={noteFocus}
              >
                <OwnedContribution
                  entry={source}
                  registry={{ snapshot: live }}
                  fallback={
                    <p role="alert" className="m-0 text-body-sm text-danger">
                      {source.title} is unavailable.
                    </p>
                  }
                >
                  {(entry, active) => (
                    <entry.component
                      name={avatarSourceName(name)}
                      seed={sourcePicks.current.get(entry)?.seed}
                      disabled={locked}
                      choose={chooseFrom(entry, active)}
                    />
                  )}
                </OwnedContribution>
              </fieldset>
            ) : mode === "emoji" ? (
              <fieldset
                className={styles.avatarDock}
                {...dockEvents}
                aria-label="Avatar background"
                disabled={locked}
              >
                {backgrounds.map((swatch) => (
                  <span key={swatch} className={styles.dockItem}>
                    <IconButton
                      data-color-swatch={swatch}
                      variant="primary"
                      shape="round"
                      size="sm"
                      icon={
                        <CircleIcon
                          size={24}
                          strokeWidth={3}
                          aria-hidden="true"
                          className={
                            color === swatch ? "opacity-100" : "opacity-0"
                          }
                        />
                      }
                      aria-label={`Use ${swatch} background`}
                      aria-pressed={color === swatch}
                      style={
                        swatch === "transparent"
                          ? undefined
                          : { backgroundColor: swatch }
                      }
                      onPointerDown={(event) => {
                        if (event.pointerType === "mouse")
                          event.preventDefault();
                      }}
                      onClick={(event) => {
                        setAnimateColor(event.detail > 0);
                        setEmoji({ color: swatch });
                      }}
                    />
                  </span>
                ))}
              </fieldset>
            ) : (
              <fieldset
                className={styles.avatarDock}
                {...dockEvents}
                aria-label="Agent avatars"
                disabled={locked}
              >
                {slots.map(({ id, avatar }, index) => (
                  <span key={id} className={styles.dockItem}>
                    <SurfaceButton
                      className={styles.avatarDockButton}
                      onPointerDown={(event) => {
                        if (event.pointerType === "mouse")
                          event.preventDefault();
                      }}
                      aria-label={avatar.label}
                      aria-pressed={picture === avatar.url}
                      onClick={(event) => {
                        swap.current?.();
                        setAnimateBackdrop(
                          event.detail > 0 && avatarMotionAllowed(),
                        );
                        if (
                          selected?.preview &&
                          avatar.preview &&
                          center.current &&
                          event.detail > 0 &&
                          avatarMotionAllowed() &&
                          typeof event.currentTarget.animate === "function"
                        ) {
                          swap.current = swapAvatarArtwork(
                            event.currentTarget,
                            center.current,
                            selected.preview,
                          );
                        }
                        setSlots((current) =>
                          current.map((item, slot) =>
                            slot === index
                              ? { ...item, avatar: selected ?? lastAvatar }
                              : item,
                          ),
                        );
                        setLastAvatar(avatar);
                        onChange({ kind: "gloopie", picture: avatar.url });
                      }}
                    >
                      <img
                        src={avatar.preview}
                        alt=""
                        loading="lazy"
                        draggable={false}
                      />
                    </SurfaceButton>
                  </span>
                ))}
              </fieldset>
            )}
          </div>
        </div>
        {busy && (
          <p role="status" className="sr-only">
            Uploading image…
          </p>
        )}
        {error && (
          <p role="alert" className="m-0 text-body-sm text-danger">
            {error}
          </p>
        )}
      </div>
      {/* Reserve help outside the card so mode changes keep its size and inset. */}
      {!community && (
        <p
          className="m-0 text-body-sm text-secondary"
          style={{ visibility: mode === "emoji" ? "visible" : "hidden" }}
        >
          Select a community to use an emoji avatar.
        </p>
      )}
    </>
  );
}
