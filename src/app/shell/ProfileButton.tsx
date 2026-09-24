import { useId, useRef, useSyncExternalStore } from "react";
import {
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
  const { profile, viewer } = useSyncExternalStore(
    communities.subscribe,
    communities.snapshot,
  );
  const presence = useSyncExternalStore(
    communities.presence.subscribe,
    communities.presence.snapshot,
  );
  const label = { online: "Active", away: "Away", offline: "Offline" }[
    presence.status
  ];
  const openingSettings = useRef(false);
  const accountLabel = useId();
  const avatar =
    profile.picture.startsWith("https://") || profile.name ? (
      <Avatar
        src={
          profile.picture.startsWith("https://") ? profile.picture : undefined
        }
        alt=""
        fallback={profile.name || "?"}
        size="fill"
      />
    ) : (
      <UserIcon aria-hidden="true" size={19} />
    );
  return (
    <MenuRoot
      modal={false}
      onOpenChange={(open) => {
        if (open) openingSettings.current = false;
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
            title={profile.name || "Your profile"}
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
        finalFocus={() => !openingSettings.current}
      >
        <span id={accountLabel} className="sr-only">
          Your account
        </span>
        <div className="flex items-center gap-3 px-3 py-2">
          <span className="relative flex size-9 shrink-0 items-center justify-center">
            {avatar}
          </span>
          <div className="min-w-0">
            <p className="m-0 truncate text-label-sm">
              {profile.name || "Your account"}
            </p>
            {viewer && (
              <p className="m-0 text-body-sm text-subtle">
                {label} · On this device
              </p>
            )}
          </div>
        </div>
        {viewer && (
          <>
            <MenuSeparator />
            <MenuRadioGroup
              value={presence.preference}
              onValueChange={(value) =>
                communities.presence.setPreference(value)
              }
              aria-label="Presence"
            >
              {(
                [
                  [
                    "auto",
                    presence.preference === "auto" ? presence.status : "online",
                    "Automatic",
                  ],
                  ["away", "away", "Away"],
                  ["offline", "offline", "Appear offline"],
                ] as const
              ).map(([value, status, name]) => (
                <MenuRadioItem key={value} value={value} closeOnClick={false}>
                  <span
                    className={styles.statusDot}
                    data-status={status}
                    aria-hidden="true"
                  />
                  {name}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
            <p className="mx-3 my-2 max-w-56 text-body-sm text-subtle">
              Automatic follows activity in Buzz. Other devices may differ.
            </p>
            {presence.error && (
              <p
                role="alert"
                className="mx-3 my-2 max-w-56 text-body-sm text-danger"
              >
                {presence.error}
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
  );
}
