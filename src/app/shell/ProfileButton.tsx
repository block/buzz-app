import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { GearIcon, UserIcon } from "../../shared/design-system/icons/index";
import type { Communities } from "../../features/communities/service";
import { useRelayConnection } from "../../features/relay/react";

const statusLabels = {
  online: "Online",
  away: "Away",
  offline: "Offline",
  unknown: "Status unavailable",
} as const;

const statusColors = {
  online: "var(--status-online)",
  away: "var(--status-away)",
  offline: "var(--status-offline)",
} as const;

const statusTextColors = {
  online: "var(--text-success)",
  away: "var(--text-warning)",
  offline: "var(--text-subtle)",
} as const;

export function ProfileButton({
  communities,
  settingsSelected,
  onSettings,
}: {
  communities: Communities;
  settingsSelected: boolean;
  onSettings(): void;
}) {
  const { profile } = useSyncExternalStore(
    communities.subscribe,
    communities.snapshot,
  );
  const connection = useRelayConnection(communities.relay);
  const viewer = connection.status === "ready" ? connection.viewer : undefined;
  const subscribeStatus = useCallback(
    (listener: () => void) =>
      viewer
        ? connection.session.presence.subscribe(viewer, listener, true)
        : () => {},
    [connection.session, viewer],
  );
  const readStatus = useCallback(
    () => (viewer ? connection.session.presence.status(viewer) : "unknown"),
    [connection.session, viewer],
  );
  const status = useSyncExternalStore(subscribeStatus, readStatus);
  const statusBadge = status === "unknown" ? undefined : status;
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: Event) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("focusin", dismiss);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("focusin", dismiss);
      document.removeEventListener("keydown", onEscape);
    };
  }, [open]);
  return (
    <div ref={container} className="relative flex items-center">
      <IconButton
        type="button"
        ref={trigger}
        onClick={(event) => {
          event.currentTarget.focus();
          setOpen((value) => !value);
        }}
        aria-label="Your profile"
        aria-expanded={open}
        aria-controls={id}
        title={profile.name || "Your profile"}
        variant={statusBadge ? "ghost" : "chrome"}
        style={statusBadge ? { background: "transparent" } : undefined}
        shape="round"
        icon={
          /* Keep pointer-origin Tab traversal rooted at the button in WebKit. */
          <span className="pointer-events-none flex size-full items-center justify-center rounded-full">
            {statusBadge ||
            profile.picture.startsWith("https://") ||
            profile.name ? (
              <Avatar
                src={
                  profile.picture.startsWith("https://")
                    ? profile.picture
                    : undefined
                }
                alt=""
                fallback={profile.name || "?"}
                size="fill"
                {...(statusBadge ? { statusBadge } : {})}
              />
            ) : (
              <UserIcon aria-hidden="true" size={19} />
            )}
          </span>
        }
      />
      <nav
        id={id}
        aria-label="Your account"
        hidden={!open}
        className="absolute top-full right-0 mt-2 w-56 max-w-[calc(100vw-2rem)] popover-surface p-2"
      >
        <div className="px-3 py-2">
          <p className="m-0 truncate text-label-sm">
            {profile.name || "Your account"}
          </p>
          <p
            className="m-0 mt-1 flex items-center gap-2 text-body-sm text-secondary"
            style={
              statusBadge ? { color: statusTextColors[statusBadge] } : undefined
            }
          >
            {statusBadge && (
              <span
                aria-hidden="true"
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: statusColors[statusBadge] }}
              />
            )}
            {statusLabels[status]}
          </p>
        </div>
        <NavigationItem
          type="button"
          aria-current={settingsSelected ? "page" : undefined}
          selected={settingsSelected}
          label="Settings"
          icon={<GearIcon aria-hidden="true" size={17} />}
          onClick={() => {
            setOpen(false);
            onSettings();
            document.getElementById("main-content")?.focus();
          }}
        />
      </nav>
    </div>
  );
}
