import { Button } from "../shared/design-system/ui/Button";
import { Input } from "../shared/design-system/ui/Input";
import { npubEncode } from "nostr-tools/nip19";
import { useState, useSyncExternalStore } from "react";
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
  const [copyStatus, setCopyStatus] = useState("");
  const profile = draft ?? client.profile;
  const hasChanges =
    draft !== null &&
    (draft.name !== client.profile.name ||
      draft.picture !== client.profile.picture ||
      (draft.about ?? "") !== (client.profile.about ?? ""));
  const npub = client.viewer ? npubEncode(client.viewer) : "";
  async function copyIdentity(value: string, label: string) {
    setCopyStatus("");
    try {
      await navigator.clipboard.writeText(value);
      setCopyStatus(`${label} copied.`);
    } catch {
      setCopyStatus(
        `Couldn’t copy ${label.toLowerCase()}. Select it and copy manually.`,
      );
    }
  }
  return (
    <section aria-labelledby="profile-settings-title">
      <h2 id="profile-settings-title" className="mt-0 mb-6 text-label">
        Profile
      </h2>
      <div>
        <p className="mt-0 text-body-sm text-muted">
          Your local default for new communities. Saving here does not change
          your existing community profiles.
        </p>
        {client.status !== "ready" ? (
          <p role="status">
            {client.status === "loading"
              ? "Opening your local identity…"
              : "Your local identity is unavailable. Connect your identity to edit your profile."}
          </p>
        ) : (
          <>
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
                <p role="status" className="m-0 text-body-sm text-muted">
                  {saved ? "Profile updated." : ""}
                </p>
              </div>
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
                  <div className="flex min-w-0 flex-wrap items-center gap-3">
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
                <p role="status" className="m-0 text-body-sm text-muted">
                  {copyStatus}
                </p>
              )}
            </section>
          </>
        )}
      </div>
    </section>
  );
}
