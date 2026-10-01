import { useState, useSyncExternalStore } from "react";
import type { ChannelLauncherProps } from "../../features/panels/service";
import type { Huddles } from "../../features/huddle/service";
import {
  HeadphonesIcon,
  PhoneDisconnectIcon,
  CaretDownIcon,
  LinkIcon,
  UsersIcon,
} from "../../shared/design-system/icons";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuIcon,
  MenuNote,
} from "../../shared/design-system/ui/Menu";
import styles from "./Huddles.module.css";

type Props = Pick<
  ChannelLauncherProps,
  "context" | "available" | "openMembers"
> & { huddles: Huddles; showWindow(): Promise<void> };
const focusPlayer = () => document.getElementById("huddle-capsule")?.focus();

export function HuddleLauncher(props: Props) {
  const { context, available, huddles } = props;
  const call = useSyncExternalStore(huddles.subscribe, huddles.snapshot);
  const active = ["connecting", "connected", "leaving"].includes(call.phase);
  const here =
    call.phase === "connected" &&
    call.destination?.scope === context.scope &&
    call.destination.viewer === context.viewer &&
    call.destination.channelId === context.channelId;
  if (here && call.id)
    return <ActiveHuddle key={call.id} {...props} callId={call.id} />;
  return (
    <IconButton
      size="toolbar"
      variant="ghost"
      icon={<HeadphonesIcon size={16} aria-hidden="true" />}
      aria-label={active ? "Show active Huddle" : "Start or join a huddle"}
      title={active ? "Show active Huddle" : "Start or join a huddle"}
      onClick={() => {
        if (!available()) return;
        if (active) {
          if (document.getElementById("huddle-capsule")) focusPlayer();
          else void props.showWindow().catch(() => {});
        } else void huddles.start(context);
      }}
    />
  );
}

function ActiveHuddle({
  context,
  available,
  openMembers,
  huddles,
  callId,
}: Props & { callId: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  const current = () =>
    available() &&
    huddles.snapshot().id === callId &&
    huddles.snapshot().phase === "connected";
  // Existing Buzz channel links preserve membership checks. Joining remains an
  // explicit headphone click in the destination, never automatic mic capture.
  const link = `buzz://channel/${encodeURIComponent(context.channelId)}`;
  return (
    <fieldset
      className={styles.activeLauncher}
      aria-label="Active Huddle in this chat"
    >
      <IconButton
        size="toolbar"
        variant="ghost"
        style={{ color: "var(--status-online)" }}
        data-huddle-leave=""
        aria-label="Leave huddle"
        title="Leave huddle"
        icon={
          <span className={styles.leaveGlyph} aria-hidden="true">
            <HeadphonesIcon size={16} className={styles.headphonesGlyph} />
            <PhoneDisconnectIcon size={16} className={styles.disconnectGlyph} />
          </span>
        }
        onClick={() => {
          if (current()) void huddles.leave();
        }}
      />
      <span className={styles.launcherDivider} aria-hidden="true" />
      <MenuRoot
        onOpenChange={(open) => {
          if (open) {
            setCopied(false);
            setError(false);
          }
        }}
      >
        <MenuTrigger
          render={
            <IconButton
              size="toolbar"
              variant="ghost"
              style={{ color: "var(--status-online)" }}
              aria-label="Huddle options"
              icon={<CaretDownIcon size={16} aria-hidden="true" />}
            />
          }
        />
        <MenuPopup align="end" size="compact">
          <MenuItem
            disabled={!openMembers}
            onClick={() => {
              if (current()) openMembers?.();
            }}
          >
            <MenuIcon>
              <UsersIcon size={16} />
            </MenuIcon>
            Add someone
          </MenuItem>
          <MenuItem
            closeOnClick={false}
            onClick={async () => {
              if (!current()) return;
              setError(false);
              try {
                await navigator.clipboard.writeText(link);
                setCopied(true);
              } catch {
                setError(true);
              }
            }}
          >
            <MenuIcon>
              <LinkIcon size={16} />
            </MenuIcon>
            {copied ? "Link copied" : "Copy link"}
          </MenuItem>
          <MenuNote>
            People need to belong to this chat. The link opens it; use the
            headphone button to join.
          </MenuNote>
          {error && (
            <MenuNote role="alert">
              Couldn’t copy. You can copy this link manually: {link}
            </MenuNote>
          )}
        </MenuPopup>
      </MenuRoot>
    </fieldset>
  );
}
