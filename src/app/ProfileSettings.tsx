import { Header } from "../shared/design-system/ui/Header";
import { Button } from "../shared/design-system/ui/Button";
import { useCallback, useState, useSyncExternalStore } from "react";
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
  const actionsRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    // Capture focus before the conditional actions leave the DOM.
    return () => {
      if (node.contains(document.activeElement))
        node.closest("form")?.querySelector<HTMLInputElement>("input")?.focus();
    };
  }, []);
  const [draft, setDraft] = useState<PersonalProfile | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const profile = draft ?? client.profile;
  const changed =
    profile.name !== client.profile.name ||
    profile.picture !== client.profile.picture;
  return (
    <section aria-labelledby="profile-settings-title">
      <Header
        id="profile-settings-title"
        title="Profile"
        subtitle="Your local default for new communities. Saving here does not change your existing community profiles."
      />
      <div>
        {client.status !== "ready" ? (
          <p role="status">
            {client.status === "loading"
              ? "Opening your local identity…"
              : "Your local identity is unavailable. Connect your identity to edit your profile."}
          </p>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!changed || !canSaveProfile(profile)) return;
              setError("");
              try {
                communities.saveProfile({
                  ...profile,
                  name: profile.name.trim(),
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
            {changed && (
              <div
                ref={actionsRef}
                className="mt-6 flex flex-wrap items-center justify-end gap-3"
              >
                <Button
                  size="sm"
                  type="button"
                  onClick={() => {
                    setDraft(null);
                    setSaved(false);
                    setError("");
                  }}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  type="submit"
                  disabled={!canSaveProfile(profile)}
                  variant="primary"
                >
                  Save
                </Button>
              </div>
            )}
            <p role="status" className="m-0 text-right text-body-sm text-muted">
              {saved ? "Profile updated." : ""}
            </p>
          </form>
        )}
      </div>
    </section>
  );
}
