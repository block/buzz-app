import { Field } from "../../shared/design-system/ui/Field";
import { Radio, RadioGroup } from "../../shared/design-system/ui/RadioGroup";
import styles from "./ProfileButton.module.css";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
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
        variant="chrome"
        shape="round"
        icon={
          /* Keep pointer-origin Tab traversal rooted at the button in WebKit. */
          <span className="pointer-events-none relative flex size-full items-center justify-center rounded-full">
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
      <nav
        id={id}
        aria-label="Your account"
        hidden={!open}
        className="absolute top-full right-0 mt-2 w-64 max-w-[calc(100vw-2rem)] popover-surface p-2"
      >
        <p className="m-0 truncate px-3 py-2 text-label-sm">
          {profile.name || "Your account"}
        </p>
        {viewer && (
          <div className="px-3 pb-3">
            <p className="mt-0 mb-3 text-body-sm text-subtle">
              {label} · On this device
            </p>
            <Field
              label="Presence"
              description="Automatic follows your activity in Buzz. Other devices may show a different status."
            >
              <RadioGroup
                name="presence"
                value={presence.preference}
                onValueChange={(value) =>
                  communities.presence.setPreference(value)
                }
              >
                <Radio value="auto" label="Automatic" />
                <Radio value="away" label="Away" />
                <Radio value="offline" label="Appear offline" />
              </RadioGroup>
            </Field>
            {presence.error && (
              <p role="alert" className="mb-0 text-body-sm text-danger">
                {presence.error}
              </p>
            )}
          </div>
        )}
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
