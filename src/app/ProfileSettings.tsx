import { Header } from "../shared/design-system/ui/Header";
import { Avatar } from "../shared/design-system/ui/Avatar";
import { Button } from "../shared/design-system/ui/Button";
import { Input } from "../shared/design-system/ui/Input";
import { ToastNotice } from "../shared/design-system/ui/Toast";
import { avatarSource } from "../shared/avatar-source";
import { npubEncode } from "nostr-tools/nip19";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import styles from "./ProfileSettings.module.css";
import type {
  Communities,
  PersonalProfile,
} from "../features/communities/service";
import {
  canSaveProfile,
  ProfileFields,
  profilesEqual,
} from "../features/communities/ProfileFields";
import * as communityApi from "../features/communities/api";
import type { Membership } from "../features/communities/service";

type LoadedProfile = Awaited<ReturnType<typeof communityApi.inspectProfile>>;

const profileSaveGenerations = new WeakMap<Communities, number>();
function beginProfileSave(communities: Communities) {
  const generation = (profileSaveGenerations.get(communities) ?? 0) + 1;
  profileSaveGenerations.set(communities, generation);
  return generation;
}
function isCurrentProfileSave(communities: Communities, generation: number) {
  return profileSaveGenerations.get(communities) === generation;
}

export function ProfileSettings({
  communities,
  community,
}: {
  communities: Communities;
  community?: Membership | undefined;
}) {
  const client = useSyncExternalStore(
    communities.subscribe,
    communities.snapshot,
  );
  const pendingFocus = useRef<HTMLInputElement | null>(null);
  const actionsRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    // Capture focus before the conditional actions leave the DOM.
    return () => {
      if (node.contains(document.activeElement))
        pendingFocus.current =
          node.closest("form")?.querySelector<HTMLInputElement>("input") ??
          null;
    };
  }, []);
  useLayoutEffect(() => {
    // The form fields may still be disabled during ref cleanup. Wait until
    // React has committed their enabled state; unmounting runs no handoff.
    const target = pendingFocus.current;
    pendingFocus.current = null;
    if (target?.isConnected) target.focus();
  });
  const [loaded, setLoaded] = useState<LoadedProfile | null>(null);
  const [loadStatus, setLoadStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >(community ? "idle" : "ready");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadError, setLoadError] = useState("");
  const [draft, setDraft] = useState<PersonalProfile | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [copyStatus, setCopyStatus] = useState<{
    message: string;
    failed: boolean;
  } | null>(null);
  const copyAttempt = useRef(0);
  // loadAttempt is an explicit recovery trigger.
  useEffect(() => {
    void loadAttempt;
    setDraft(null);
    setLoaded(null);
    setSaved(false);
    setLoadError("");
    setError("");
    if (!community) {
      setLoadStatus("ready");
      return;
    }
    let current = true;
    setLoadStatus("loading");
    void communityApi.inspectProfile(community.id).then(
      (result) => {
        if (!current) return;
        setLoaded(result);
        setLoadStatus("ready");
      },
      (reason) => {
        if (!current) return;
        setLoadStatus("error");
        setLoadError(reason instanceof Error ? reason.message : String(reason));
      },
    );
    return () => {
      current = false;
    };
  }, [community, loadAttempt]);
  const persisted =
    community && loaded?.exists ? loaded.profile : client.profile;
  const profile = draft ?? persisted;
  const hasChanges = draft !== null && !profilesEqual(draft, persisted);
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
      <Header
        id="profile-settings-title"
        title="Profile"
        subtitle={
          community
            ? "Set your profile details for this community. Any existing community profiles won’t be changed."
            : "Set your profile details. Any existing community profiles won’t be changed."
        }
      />
      <div>
        {client.status !== "ready" ? (
          <p role="status">
            {client.status === "loading"
              ? "Opening your local identity…"
              : "Your local identity is unavailable. Connect your identity to edit your profile."}
          </p>
        ) : community && loadStatus !== "ready" ? (
          <div>
            {loadStatus === "error" ? (
              <>
                <p role="alert" className="error">
                  Your profile in {community.name} couldn’t be loaded.{" "}
                  {loadError}
                </p>
                <Button
                  type="button"
                  onClick={() => setLoadAttempt((value) => value + 1)}
                >
                  Retry loading profile
                </Button>
              </>
            ) : (
              <p role="status">Loading your profile in {community.name}…</p>
            )}
          </div>
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
                if (
                  saving ||
                  !hasChanges ||
                  !canSaveProfile(profile) ||
                  (community && !loaded)
                )
                  return;
                const next = {
                  ...profile,
                  name: profile.name.trim(),
                  about: profile.about?.trim() ?? "",
                };
                const saveGeneration = beginProfileSave(communities);
                setSaving(true);
                setSaved(false);
                setError("");
                void (async () => {
                  try {
                    if (community && loaded) {
                      await communityApi.publishProfile(
                        community.id,
                        next,
                        loaded.existing,
                      );
                      setLoaded({
                        exists: true,
                        existing: { ...loaded.existing, ...next },
                        profile: next,
                      });
                    }
                    if (isCurrentProfileSave(communities, saveGeneration))
                      communities.saveProfile(next);
                    setDraft(null);
                    setSaved(true);
                  } catch (reason) {
                    setError(
                      reason instanceof Error ? reason.message : String(reason),
                    );
                  } finally {
                    setSaving(false);
                  }
                })();
              }}
            >
              <ProfileFields
                profile={profile}
                disabled={saving}
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
              {hasChanges && (
                <div
                  ref={actionsRef}
                  className="mt-6 flex flex-wrap items-center justify-end gap-3"
                >
                  <Button
                    size="sm"
                    type="button"
                    disabled={saving}
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
                    loading={saving}
                    disabled={!canSaveProfile(profile)}
                    variant="primary"
                  >
                    Save
                  </Button>
                </div>
              )}
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
