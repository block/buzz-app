import { Avatar } from "../shared/design-system/ui/Avatar";
import { Button } from "../shared/design-system/ui/Button";
import { Input } from "../shared/design-system/ui/Input";
import { ToastNotice } from "../shared/design-system/ui/Toast";
import { avatarSource } from "../shared/avatar-source";
import { npubEncode } from "nostr-tools/nip19";
import { useRef, useState, useSyncExternalStore } from "react";
import styles from "./ProfileSettings.module.css";
import type {
  Communities,
  PersonalProfile,
} from "../features/communities/service";
import {
  canSaveProfile,
  ProfileFields,
} from "../features/communities/ProfileFields";

export function ProfileSettings({ communities }: { communities: Communities }) {
  const client = useSyncExternalStore(
    communities.subscribe,
    communities.snapshot,
  );
  const [draft, setDraft] = useState<PersonalProfile | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [copyStatus, setCopyStatus] = useState<{
    message: string;
    failed: boolean;
  } | null>(null);
  const copyAttempt = useRef(0);
  const profile = draft ?? client.profile;
  const hasChanges =
    draft !== null &&
    (draft.name !== client.profile.name ||
      draft.picture !== client.profile.picture ||
      (draft.about ?? "") !== (client.profile.about ?? ""));
  const npub = client.viewer ? npubEncode(client.viewer) : "";
  async function copyIdentity(value: string, label: string) {
    const attempt = ++copyAttempt.current;
    setCopyStatus(null);
    try {
      await navigator.clipboard.writeText(value);
      if (attempt === copyAttempt.current)
        setCopyStatus({ message: `${label} copied.`, failed: false });
    } catch {
      if (attempt === copyAttempt.current)
        setCopyStatus({
          message: `Couldn’t copy ${label.toLowerCase()}. Select it and copy manually.`,
          failed: true,
        });
    }
  }
  return (
    <section aria-labelledby="profile-settings-title">
      <h2 id="profile-settings-title" className="mt-0 mb-6 text-label">
        Profile
      </h2>
      <div>
        <p className="mt-0 text-body-sm text-muted">
          Set your profile details. Any existing community profiles won’t be
          changed.
        </p>
        {client.status !== "ready" ? (
          <p role="status">
            {client.status === "loading"
              ? "Opening your local identity…"
              : "Your local identity is unavailable. Connect your identity to edit your profile."}
          </p>
        ) : (
          <>
            <section aria-label="Profile preview" className={styles.preview}>
              <div className={styles.avatar}>
                <Avatar
                  src={avatarSource(profile.picture)}
                  alt=""
                  fallback={profile.name || "Your profile"}
                  size="fill"
                />
              </div>
              <h3 className="text-label">
                {profile.name.trim() || "Your profile"}
              </h3>
              {profile.about?.trim() ? (
                <p className={`${styles.about} text-body-sm text-muted`}>
                  {profile.about.trim()}
                </p>
              ) : null}
            </section>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (!hasChanges || !canSaveProfile(profile)) return;
                setError("");
                try {
                  communities.saveProfile({
                    ...profile,
                    name: profile.name.trim(),
                    about: profile.about?.trim() ?? "",
                  });
                  setDraft(null);
                  setSaved(true);
                } catch (reason) {
                  setSaved(false);
                  setError(
                    reason instanceof Error ? reason.message : String(reason),
                  );
                }
              }}
            >
              <ProfileFields
                profile={profile}
                onChange={(next) => {
                  setDraft(next);
                  setSaved(false);
                  setError("");
                }}
              />
              {error && (
                <p role="alert" className="error">
                  {error}
                </p>
              )}
              <div className="mt-6 flex flex-wrap items-center gap-3">
                <Button
                  type="submit"
                  disabled={!hasChanges || !canSaveProfile(profile)}
                  variant="primary"
                >
                  Save profile
                </Button>
                <Button
                  type="button"
                  disabled={!hasChanges}
                  onClick={() => {
                    setDraft(null);
                    setSaved(false);
                    setError("");
                  }}
                >
                  Cancel
                </Button>
              </div>
              {saved && (
                <ToastNotice
                  title="Profile updated"
                  tone="success"
                  timeout={5000}
                  onDismiss={() => setSaved(false)}
                />
              )}
            </form>
            <section aria-labelledby="identity-settings-title" className="mt-8">
              <h3 id="identity-settings-title" className="m-0 text-label-sm">
                Identity
              </h3>
              <p className="mt-2 mb-4 text-body-sm text-muted">
                Your public identity can be shared safely. It does not reveal
                your private key.
              </p>
              {(
                [
                  [
                    "Public key (hex)",
                    "Public key",
                    client.viewer ?? "",
                    "public-key",
                  ],
                  [
                    "Nostr address (npub)",
                    "Nostr address",
                    npub,
                    "nostr-address",
                  ],
                ] as const
              ).map(([label, copyLabel, value, id]) => (
                <div className="mb-4 min-w-0" key={label}>
                  <label className="mb-2 block text-label-sm" htmlFor={id}>
                    {label}
                  </label>
                  <div className={styles.identityRow}>
                    <Input
                      id={id}
                      readOnly
                      value={value}
                      onFocus={(event) => event.currentTarget.select()}
                    />
                    <Button
                      type="button"
                      onClick={() => void copyIdentity(value, copyLabel)}
                    >
                      Copy {copyLabel.toLowerCase()}
                    </Button>
                  </div>
                </div>
              ))}
              {copyStatus && (
                <ToastNotice
                  title={
                    copyStatus.failed
                      ? "Identity wasn’t copied"
                      : copyStatus.message
                  }
                  {...(copyStatus.failed
                    ? { description: copyStatus.message }
                    : {})}
                  tone={copyStatus.failed ? "error" : "success"}
                  timeout={copyStatus.failed ? 0 : 5000}
                  onDismiss={() => setCopyStatus(null)}
                />
              )}
            </section>
          </>
        )}
      </div>
    </section>
  );
}
