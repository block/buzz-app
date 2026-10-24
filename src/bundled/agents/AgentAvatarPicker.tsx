import { EmojiSwap } from "./EmojiSwap";
import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
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
  emojiAvatar,
  uploadAvatar,
} from "../../features/profiles/avatar-upload";
import { useAvatarPreview } from "../../features/profiles/use-avatar-preview";
import {
  CircleIcon,
  DotsThreeIcon,
  ImageIcon,
  SmileyIcon,
} from "../../shared/design-system/icons";
import { ProfileBackdrop } from "../../features/profiles/ProfileBackdrop";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuIcon,
} from "../../shared/design-system/ui/Menu";
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
} from "../../shared/design-system/ui/Popover";
import { SurfaceButton } from "../../shared/design-system/ui/SurfaceButton";
import { PackedAgentAvatar } from "./PackedAgentAvatar";
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
] as const;

export type AvatarSelection =
  | { kind: "gloopie"; picture: string }
  | { kind: "emoji"; emoji: string; color: string }
  | { kind: "image"; picture: string };

const defaultEmojiColor = backgrounds[0];

export function AgentAvatarPicker({
  name,
  selection,
  disabled,
  community,
  onChange,
  onBusyChange,
  avatarRef,
}: {
  name: string;
  selection: AvatarSelection;
  disabled: boolean;
  community?: string | undefined;
  onChange(selection: AvatarSelection): void;
  onBusyChange(busy: boolean): void;
  avatarRef: Ref<{ prepare(): Promise<string> }>;
}) {
  const mode = selection.kind;
  const picture = selection.kind === "emoji" ? "" : selection.picture;
  const lastEmoji = useRef("😀");
  const lastColor = useRef<string>(defaultEmojiColor);
  const [animateEmoji, setAnimateEmoji] = useState(false);
  const emoji =
    selection.kind === "emoji" ? selection.emoji : lastEmoji.current;
  const color =
    selection.kind === "emoji" ? selection.color : lastColor.current;
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [busy, setBusy] = useState(false);
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
  const [slots, setSlots] = useState(() =>
    agentAvatars
      .filter((avatar) => avatar.url !== picture)
      .map((avatar) => ({ id: avatar.id, avatar })),
  );
  const center = useRef<HTMLDivElement>(null);
  const swap = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => swap.current?.(), []);
  const dockPointer = useRef<number | null>(null);
  const [magnifier] = useState(createDockMagnifier);
  useEffect(() => () => magnifier.dispose(), [magnifier]);
  const resetDock = (dock: HTMLElement) => {
    dockPointer.current = null;
    magnifier.move(dock, null);
  };
  const dockEvents = {
    onPointerMove: (event: React.PointerEvent<HTMLFieldSetElement>) => {
      const dock = event.currentTarget;
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
    onPointerLeave: (event: React.PointerEvent<HTMLFieldSetElement>) =>
      resetDock(event.currentTarget),
    onKeyDown: (event: React.KeyboardEvent<HTMLFieldSetElement>) => {
      dockPointer.current = null;
      magnifier.move(event.currentTarget, null, true);
    },
    onScroll: (event: React.UIEvent<HTMLFieldSetElement>) =>
      magnifier.move(event.currentTarget, dockPointer.current),
  };
  const preview = useAvatarPreview(selected ? "" : picture, community, "small");
  useEffect(() => () => pending.current?.abort(), []);
  useImperativeHandle(avatarRef, () => ({
    async prepare() {
      if (selection.kind !== "emoji") return selection.picture;
      if (!community)
        throw new Error("Select a community to use an emoji avatar.");
      const request = new AbortController();
      pending.current = request;
      try {
        const file = await emojiAvatar(selection.emoji, selection.color);
        request.signal.throwIfAborted();
        return await uploadAvatar(file, community, request.signal);
      } finally {
        if (pending.current === request) pending.current = null;
      }
    },
  }));
  const upload = async (file: File) => {
    if (!community || pending.current || disabled) return;
    const request = new AbortController();
    pending.current = request;
    setBusy(true);
    onBusyChange(true);
    setError("");
    try {
      const value = await uploadAvatar(file, community, request.signal);
      if (!request.signal.aborted) {
        onChange({ kind: "image", picture: value });
      }
    } catch (reason) {
      if (!request.signal.aborted)
        setError(
          reason instanceof Error
            ? reason.message
            : "Image upload failed. Try again.",
        );
    } finally {
      if (!request.signal.aborted) {
        pending.current = null;
        setBusy(false);
        onBusyChange(false);
      }
    }
  };
  const locked = disabled || busy;
  return (
    <div
      className={styles.avatarSurface}
      style={
        mode === "emoji"
          ? {
              backgroundColor: `color-mix(in srgb, ${color} 14%, var(--surface-panel))`,
            }
          : undefined
      }
    >
      {mode !== "emoji" && (
        <ProfileBackdrop src={selected?.preview ?? preview} />
      )}
      <div className="flex items-center justify-between gap-3 p-3">
        <span className="text-body-sm text-secondary">Choose an avatar</span>
        <MenuRoot>
          <MenuTrigger
            render={
              <IconButton
                aria-label="Customize avatar"
                icon={<DotsThreeIcon />}
                variant="glass"
                shape="round"
                disabled={locked}
              />
            }
          />
          <MenuPopup>
            <MenuItem
              onClick={() => {
                onChange({ kind: "gloopie", picture: lastAvatar.url });
                setError("");
              }}
            >
              <MenuIcon>
                <Avatar
                  src={lastAvatar.preview}
                  alt=""
                  fallback={lastAvatar.label}
                  size="fill"
                  shape="circle"
                />
              </MenuIcon>
              Gloopies
            </MenuItem>
            <MenuItem
              onClick={() => {
                onChange({
                  kind: "emoji",
                  emoji: lastEmoji.current,
                  color: lastColor.current,
                });
                setError("");
              }}
            >
              <MenuIcon>
                <SmileyIcon />
              </MenuIcon>
              Emoji
            </MenuItem>
            <MenuItem
              onClick={() => {
                if (!community) {
                  setError("Select a community to upload an image.");
                  return;
                }
                input.current?.click();
              }}
            >
              <MenuIcon>
                <ImageIcon />
              </MenuIcon>
              Upload image
            </MenuItem>
          </MenuPopup>
        </MenuRoot>
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
        <div ref={center} className={styles.avatarSelected}>
          {mode === "emoji" ? (
            <PopoverRoot open={emojiOpen} onOpenChange={setEmojiOpen}>
              <PopoverTrigger
                render={
                  <SurfaceButton
                    className={styles.emojiAvatarButton}
                    style={{ backgroundColor: color }}
                    aria-label="Choose emoji"
                    disabled={locked}
                  />
                }
              >
                <EmojiSwap emoji={emoji} animate={animateEmoji} />
              </PopoverTrigger>
              <PopoverPopup
                aria-label="Choose emoji"
                side="bottom"
                align="start"
              >
                <AvatarEmojiPicker
                  disabled={locked}
                  onSelect={(value, animate) => {
                    setAnimateEmoji(animate);
                    lastEmoji.current = value;
                    onChange({ kind: "emoji", emoji: value, color });
                    setEmojiOpen(false);
                  }}
                />
              </PopoverPopup>
            </PopoverRoot>
          ) : selected ? (
            <PackedAgentAvatar avatar={selected} />
          ) : (
            <Avatar
              src={preview}
              alt="Selected avatar"
              fallback={name}
              size="fill"
              shape="circle"
            />
          )}
        </div>
        <div className={styles.dockSurface}>
          <div
            aria-hidden="true"
            className={`${styles.dockGlass} glass-secondary`}
          />
          {mode === "emoji" ? (
            <fieldset
              className={styles.avatarDock}
              {...dockEvents}
              aria-label="Avatar background"
              disabled={locked}
            >
              {backgrounds.map((swatch) => (
                <span key={swatch} className={styles.dockItem}>
                  <IconButton
                    data-color-swatch=""
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
                    style={{ backgroundColor: swatch }}
                    onPointerDown={(event) => {
                      if (event.pointerType === "mouse") event.preventDefault();
                    }}
                    onClick={() => {
                      lastColor.current = swatch;
                      onChange({ kind: "emoji", emoji, color: swatch });
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
                      if (event.pointerType === "mouse") event.preventDefault();
                    }}
                    aria-label={avatar.label}
                    aria-pressed={picture === avatar.url}
                    onClick={(event) => {
                      swap.current?.();
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
                          avatar.preview,
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
                    <img src={avatar.preview} alt="" loading="lazy" />
                  </SurfaceButton>
                </span>
              ))}
            </fieldset>
          )}
        </div>
      </div>
      {busy && (
        <p role="status" className="m-0 text-body-sm text-secondary">
          Uploading image…
        </p>
      )}
      {error && (
        <p role="alert" className="m-0 text-body-sm text-danger">
          {error}
        </p>
      )}
      {mode === "emoji" && !community && (
        <p className="m-0 text-body-sm text-secondary">
          Select a community to use an emoji avatar.
        </p>
      )}
    </div>
  );
}
