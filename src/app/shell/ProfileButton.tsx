import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
} from "../../shared/design-system/ui/Popover";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { useRef, useState, useSyncExternalStore } from "react";
import { GearIcon, UserIcon } from "../../shared/design-system/icons/index";
import type { Communities } from "../../features/communities/service";

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
  const [open, setOpen] = useState(false);
  const openingSettings = useRef(false);
  return (
    <PopoverRoot
      open={open}
      onOpenChange={(next) => {
        if (next) openingSettings.current = false;
        setOpen(next);
      }}
    >
      <PopoverTrigger
        render={
          <IconButton
            type="button"
            onClick={(event) => event.currentTarget.focus()}
            aria-label="Your profile"
            title={profile.name || "Your profile"}
            variant="chrome"
            shape="round"
            icon={
              /* Keep pointer-origin Tab traversal rooted at the button in WebKit. */
              <span className="pointer-events-none flex size-full items-center justify-center rounded-full">
                {profile.picture.startsWith("https://") || profile.name ? (
                  <Avatar
                    src={
                      profile.picture.startsWith("https://")
                        ? profile.picture
                        : undefined
                    }
                    alt=""
                    fallback={profile.name || "?"}
                    size="fill"
                  />
                ) : (
                  <UserIcon aria-hidden="true" size={19} />
                )}
              </span>
            }
          />
        }
      />
      <PopoverPopup
        align="end"
        initialFocus={false}
        padding="list"
        aria-label="Your account"
        style={{ width: "14rem" }}
        finalFocus={() => !openingSettings.current}
      >
        <nav aria-label="Your account">
          <p className="m-0 truncate px-3 py-2 text-label-sm">
            {profile.name || "Your account"}
          </p>
          <NavigationItem
            type="button"
            aria-current={settingsSelected ? "page" : undefined}
            selected={settingsSelected}
            label="Settings"
            icon={<GearIcon aria-hidden="true" size={17} />}
            onClick={() => {
              openingSettings.current = true;
              setOpen(false);
              onSettings();
              document.getElementById("main-content")?.focus();
            }}
          />
        </nav>
      </PopoverPopup>
    </PopoverRoot>
  );
}
