import { formatPublicKey } from "../../shared/identity/public-key";
import { useRelayConnection } from "../../features/relay/react";
import { useUserStatus } from "../../features/user-status/useUserStatus";
import { useStatusEditor } from "../../features/user-status/useStatusEditor";
import { StatusEmoji } from "../../features/user-status/StatusEmoji";
import { Button } from "../../shared/design-system/ui/Button";
import { StatusEditor } from "../../features/user-status/StatusEditor";
import { useId, useRef, useState, useSyncExternalStore } from "react";
import {
  SmileyIcon,
  CheckIcon,
  GearIcon,
  UserIcon,
} from "../../shared/design-system/icons/index";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuItem,
  MenuIcon,
  MenuSeparator,
  MenuTrailing,
} from "../../shared/design-system/ui/Menu";
import type { Communities } from "../../features/communities/service";
import styles from "./ProfileButton.module.css";

export function ProfileButton({
  communities,
  settingsSelected,
  onSettings,
}: {
  communities: Communities;
  settingsSelected: boolean;
  onSettings(): void;
}) {
  const { profile: localProfile, viewer } = useSyncExternalStore(
    communities.subscribe,
    communities.snapshot,
  );
  const presence = useSyncExternalStore(
    communities.presence.subscribe,
    communities.presence.snapshot,
  );
  const label = { online: "Online", away: "Away", offline: "Offline" }[
    presence.status
  ];
  const connection = useRelayConnection(communities.relay);
  const session = connection.session;
  const name =
    localProfile.name.trim() ||
    (viewer ? formatPublicKey(viewer) : undefined) ||
    "Your profile";
  const picture = localProfile.picture.startsWith("https://")
    ? localProfile.picture
    : undefined;
  const status = useUserStatus(session?.statuses, viewer ?? "");
  const statusEditor = useStatusEditor(session, viewer ?? undefined);
  const profileTrigger = useRef<HTMLButtonElement>(null);
  const openingStatus = useRef(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const openingSettings = useRef(false);
  const accountLabel = useId();
  const avatar =
    picture || name ? (
      <Avatar src={picture || undefined} alt="" fallback={name} size="fill" />
    ) : (
      <UserIcon aria-hidden="true" size={19} />
    );
  return (
    <>
      <MenuRoot
        modal={false}
        open={menuOpen}
        onOpenChange={(open) => {
          setMenuOpen(open);
          if (open) {
            openingSettings.current = false;
            openingStatus.current = false;
          } else {
            statusEditor.cancelOpening();
            openingStatus.current = false;
          }
        }}
        onOpenChangeComplete={(open) => {
          // Let the menu finish its keyboard handling before handing focus to
          // the page. Other dismissals retain the shared menu's focus behavior.
          if (!open && openingSettings.current) {
            const main = document.getElementById("main-content");
            // A user may already be editing Settings while the menu animates out.
            if (!main?.contains(document.activeElement)) main?.focus();
          }
        }}
      >
        <MenuTrigger
          render={
            <IconButton
              type="button"
              aria-label="Your profile"
              ref={profileTrigger}
              title={name}
              variant="chrome"
              shape="round"
              icon={
                <span className="pointer-events-none relative flex size-full items-center justify-center rounded-full">
                  {avatar}
                  {viewer && (
                    <span
                      role="img"
                      aria-label={`Your status: ${label}`}
                      className={styles.dot}
                      data-status={presence.status}
                    />
                  )}
                </span>
              }
            />
          }
        />
        <MenuPopup
          align="end"
          sideOffset={8}
          aria-labelledby={accountLabel}
          finalFocus={() => !openingSettings.current && !openingStatus.current}
        >
          <span id={accountLabel} className="sr-only">
            {name}
          </span>
          <div className={styles.profileHeader}>
            <span className={styles.profileAvatar}>
              {avatar}
              {viewer && (
                <span
                  className={styles.dot}
                  data-status={presence.status}
                  aria-hidden="true"
                />
              )}
            </span>
            <div className={styles.profileDetails}>
              <p className="m-0 truncate text-label-sm">{name}</p>
              {viewer && (
                <MenuRoot modal={false}>
                  <MenuTrigger
                    aria-label={`Availability: ${label}`}
                    render={
                      <Button variant="subtle" size="xs">
                        <span
                          className={styles.availability}
                          data-status={presence.status}
                        >
                          {label}
                        </span>
                      </Button>
                    }
                  />
                  <MenuPopup align="start">
                    <MenuRadioGroup
                      value={presence.preference}
                      onValueChange={(value) =>
                        communities.presence.setPreference(value)
                      }
                      aria-label="Availability"
                    >
                      {(
                        [
                          ["auto", "Automatic"],
                          ["online", "Online"],
                          ["away", "Away"],
                          ["offline", "Offline"],
                        ] as const
                      ).map(([value, name]) => (
                        <MenuRadioItem key={value} value={value}>
                          {name}
                        </MenuRadioItem>
                      ))}
                    </MenuRadioGroup>
                  </MenuPopup>
                </MenuRoot>
              )}
            </div>
          </div>
          {presence.error && (
            <p
              role="alert"
              className="mx-3 my-2 max-w-56 text-body-sm text-danger"
            >
              {presence.error}
            </p>
          )}
          {viewer && session?.statuses && (
            <>
              <div className={styles.statusCard}>
                <MenuItem
                  aria-label={
                    status
                      ? `Set a status: ${[status.emoji, status.text].filter(Boolean).join(" ")}`
                      : "Set a status"
                  }
                  closeOnClick={false}
                  disabled={statusEditor.loading || !session.statuses.writable}
                  onClick={async () => {
                    if (await statusEditor.open()) {
                      openingStatus.current = true;
                      setMenuOpen(false);
                    }
                  }}
                >
                  {status ? (
                    <>
                      <StatusEmoji session={session} value={status.emoji} />
                      <span className="min-w-0 truncate text-body-sm">
                        {status.text}
                      </span>
                    </>
                  ) : (
                    <>
                      <MenuIcon>
                        <SmileyIcon size={17} aria-hidden="true" />
                      </MenuIcon>
                      {statusEditor.loading
                        ? "Loading status…"
                        : "Set a status"}
                    </>
                  )}
                </MenuItem>
              </div>
              {!session.statuses.writable && (
                <p className="mx-3 my-2 max-w-56 text-body-sm text-muted">
                  Status updates are unavailable in this community.
                </p>
              )}
              {statusEditor.error && (
                <p
                  role="alert"
                  className="mx-3 my-2 max-w-56 text-body-sm text-danger"
                >
                  {statusEditor.error}
                </p>
              )}
            </>
          )}
          <MenuSeparator />
          <MenuItem
            aria-current={settingsSelected ? "page" : undefined}
            onClick={() => {
              openingSettings.current = true;
              onSettings();
            }}
          >
            <MenuIcon>
              <GearIcon aria-hidden="true" size={17} />
            </MenuIcon>
            Settings
            {settingsSelected && (
              <MenuTrailing>
                <CheckIcon aria-hidden="true" size={14} />
              </MenuTrailing>
            )}
          </MenuItem>
        </MenuPopup>
      </MenuRoot>
      {statusEditor.editor && session && connection.scope && (
        <StatusEditor
          session={session}
          scope={connection.scope}
          current={statusEditor.editor.current}
          close={statusEditor.close}
          finalFocus={profileTrigger}
        />
      )}
    </>
  );
}
