import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { npubEncode } from "nostr-tools/nip19";
import type { BackupStatus } from "../features/identity/backup";
import { BACKUP_FAILURES } from "../features/identity/backup-failure";
import {
  backupOfferedFor,
  federatedBuilderlabAccount,
} from "../features/identity/builderlab-account";
import type { Identity } from "../features/identity/service";
import type { FederatedIdentity } from "../features/federated-identity/service";
import { recoveryMessage } from "../features/federated-identity/CommunitySignIn";
import { PrivateKey } from "../features/identity/PrivateKey";
import { SignOutDialog } from "../features/identity/SignOut";
import { Header, InlineHeader } from "../shared/design-system/ui/Header";
import { SettingsGroup } from "../shared/design-system/ui/SettingsGroup";
import { PreferenceRow } from "../shared/design-system/ui/PreferenceRow";
import { IconButton } from "../shared/design-system/ui/IconButton";
import { Button } from "../shared/design-system/ui/Button";
import { Field } from "../shared/design-system/ui/Field";
import { Radio, RadioGroup } from "../shared/design-system/ui/RadioGroup";
import { relativeTimestamp } from "../shared/relative-timestamp";
import { restoreChoice } from "../features/identity/restore-choice";
import { canRestore } from "../features/identity/Welcome";
import { CHANNEL_ACTIVITY_KINDS } from "../features/relay/channel-activity";
import type { RelayData } from "../features/relay/service";
import { Tooltip } from "../shared/design-system/ui/Tooltip";
import { ToastNotice } from "../shared/design-system/ui/Toast";
import { CopyIcon } from "../shared/design-system/icons";
import styles from "./IdentitySettings.module.css";
import { writeClipboardText } from "../shared/clipboard";

const WAITING = {
  no_consent: "Automatic backup is off for this key.",
  no_session: "Sign in to Builderlab to back up your key.",
  not_linked: BACKUP_FAILURES.not_linked.message,
} as const;

/** One sentence per uploader status; failures read as first run's copy. */
function backupSentence(status: BackupStatus) {
  switch (status.status) {
    case "idle":
      // Nothing has run this launch; a backup may still exist from an earlier one.
      return "Buzz hasn’t checked your key’s backup since it opened.";
    case "running":
      return "Backing up your key…";
    case "complete":
      return "Your key is backed up to Builderlab.";
    case "waiting":
      return WAITING[status.reason];
    case "failed": {
      // Settings has no Try again; a new Builderlab sign-in hands the
      // uploader a session, which starts another pass, so a kind it clears
      // (every retryable one, and a lapsed sign-in) says so.
      const failure: { cause?: string; message: string } =
        BACKUP_FAILURES[status.kind];
      return failure.cause
        ? `${failure.cause} Buzz tries again when you next sign in to Builderlab.`
        : failure.message;
    }
  }
}

/**
 * Read-only until the consent wording is signed off. Hidden wherever first run
 * would not offer backup, by the same rule.
 */
function BackupRow({
  backup,
  offered,
}: {
  backup: Identity["backup"];
  offered: boolean;
}) {
  const status = useSyncExternalStore(backup.subscribe, backup.snapshot);
  if (!offered || !status) return null;
  return (
    <PreferenceRow
      title="Key backup"
      subtitle={<span role="status">{backupSentence(status)}</span>}
    />
  );
}

/** The window, back from now, a key's chat messages are counted in. */
const RECENT_SECONDS = 7 * 24 * 60 * 60;
/** The relay read cap: a count at it shows as at least this many. */
const RECENT_LIMIT = 500;

export type KeyActivity = { at: number; sent: number };

/**
 * `pubkey`'s newest channel activity and its chat messages in the last 7 days
 * on the current community's relay, in one read; undefined with neither.
 */
export async function keyActivity(
  relay: Pick<RelayData, "snapshot">,
  pubkey: string,
): Promise<KeyActivity | undefined> {
  const connection = relay.snapshot();
  if (connection.status !== "ready") return undefined;
  const since = Math.floor(Date.now() / 1000) - RECENT_SECONDS;
  const events = await connection.session.read(
    // Relay reads must name kinds: channel activity, the messages people see.
    [
      { kinds: [...CHANNEL_ACTIVITY_KINDS], authors: [pubkey], limit: 1 },
      { kinds: [9], authors: [pubkey], since, limit: RECENT_LIMIT },
    ],
    { priority: "background" },
  );
  if (!events.length) return undefined;
  const sent = new Set(
    events
      .filter((event) => event.kind === 9 && event.created_at >= since)
      .map((event) => event.id),
  ).size;
  return { at: Math.max(...events.map((event) => event.created_at)), sent };
}

type BackedUp =
  | { revision: string; linked: string | null; backups: readonly string[] }
  | { revision: string; failed: string };

/**
 * The account's backed-up keys, read with the organization sign-in as first
 * run reads them (`nsec-backups/status`), shown once one isn't this device's.
 * Switching signs out; first-run recovery then preselects the chosen key.
 */
function BackedUpKeys({
  viewer,
  identity,
  federated,
  lastActive,
  onSwitch,
}: {
  viewer: string;
  identity: Identity;
  federated: FederatedIdentity;
  lastActive?:
    | ((pubkey: string) => Promise<KeyActivity | undefined>)
    | undefined;
  onSwitch: (pubkey: string) => void;
}) {
  const session = useSyncExternalStore(
    federated.subscribe,
    federated.snapshot,
    federated.snapshot,
  );
  const revision =
    session.status === "signed-in" && session.authority
      ? session.revision
      : undefined;
  const [read, setRead] = useState<BackedUp>();
  // null: no events there; false: the read failed.
  const [active, setActive] = useState<
    Readonly<Record<string, KeyActivity | null | false>>
  >({});
  const [picked, setPicked] = useState<string>();
  useEffect(() => {
    if (!revision) return;
    let current = true;
    const account = federatedBuilderlabAccount(
      { value: revision },
      federated,
      identity,
    );
    Promise.all([account.linkedKey(), account.backupStatus()]).then(
      ([linked, backups]) => {
        if (!current) return;
        const keys = backups === "unavailable" ? [] : backups;
        setRead({ revision, linked, backups: keys });
        for (const key of keys)
          void lastActive?.(key).then(
            (at) => {
              if (current) setActive((all) => ({ ...all, [key]: at ?? null }));
            },
            (error: unknown) => {
              console.warn("Couldn’t read a backed-up key’s activity", error);
              if (current) setActive((all) => ({ ...all, [key]: false }));
            },
          );
      },
      (error: unknown) => {
        if (current)
          setRead({
            revision,
            failed: error instanceof Error ? error.message : String(error),
          });
      },
    );
    return () => {
      current = false;
    };
  }, [revision, federated, identity, lastActive]);
  const shown = read?.revision === revision ? read : undefined;
  if (!revision)
    return (
      <PreferenceRow
        title="Backed-up keys"
        subtitle="Sign in to your organization to see your backed-up keys."
      />
    );
  if (!shown)
    return (
      <PreferenceRow
        title="Backed-up keys"
        subtitle={<span role="status">Checking your backups…</span>}
      />
    );
  if ("failed" in shown)
    return (
      <PreferenceRow
        title="Backed-up keys"
        subtitle={
          <span role="alert">Couldn’t check your backups. {shown.failed}</span>
        }
      />
    );
  // Only a switch first run's Welcome back can finish: it restores from
  // the account's linked key and its backups.
  if (
    !shown.backups.some((key) => key !== viewer) ||
    !canRestore(shown.linked ?? undefined, shown.backups)
  )
    return null;
  const choice = shown.backups.includes(picked ?? "") ? picked : undefined;
  return (
    <PreferenceRow
      title="Backed-up keys"
      subtitle={
        <Field
          label="Backed-up keys"
          labelVisibility="hidden"
          nativeLabel={false}
        >
          <RadioGroup
            aria-label="Backed-up keys"
            value={choice ?? null}
            onValueChange={(value) => value && setPicked(value)}
          >
            {shown.backups.map((key) => {
              const at = active[key];
              return (
                <Radio
                  key={key}
                  value={key}
                  disabled={key === viewer}
                  label={
                    [
                      key === viewer && "This device",
                      key === shown.linked && "Linked",
                    ]
                      .filter(Boolean)
                      .join(", ") || "Backed-up key"
                  }
                  description={
                    <>
                      <code className={`text-mono ${styles.identityValue}`}>
                        {npubEncode(key)}
                      </code>
                      {lastActive &&
                        (at === undefined
                          ? "Checking activity…"
                          : at === null
                            ? "No activity here"
                            : at === false
                              ? "Couldn’t check activity"
                              : `Last active ${relativeTimestamp(at.at)} · ${at.sent >= RECENT_LIMIT ? `${RECENT_LIMIT}+` : at.sent} ${at.sent === 1 ? "message" : "messages"} in 7 days`)}
                    </>
                  }
                />
              );
            })}
          </RadioGroup>
        </Field>
      }
      trailing={
        <Button
          type="button"
          disabled={!choice}
          onClick={() => choice && onSwitch(choice)}
        >
          Switch to this key
        </Button>
      }
    />
  );
}

export function IdentitySettings({
  viewer,
  identity,
  federatedIdentity,
  builderlabIdentity,
  lastActive,
}: {
  viewer?: string | undefined;
  identity?: Identity | undefined;
  federatedIdentity?: FederatedIdentity | undefined;
  /**
   * The same session as the Builderlab plugin's bundled installation, as
   * first run uses it: the host's own refuses authenticated requests.
   */
  builderlabIdentity?: FederatedIdentity | undefined;
  /** `pubkey`'s newest channel activity and recent message count on the current community's relay. */
  lastActive?:
    | ((pubkey: string) => Promise<KeyActivity | undefined>)
    | undefined;
}) {
  const [signingOut, setSigningOut] = useState(false);
  const [offered, setOffered] = useState(false);
  useEffect(() => {
    if (identity) void backupOfferedFor(identity.backup).then(setOffered);
  }, [identity]);
  const [copyStatus, setCopyStatus] = useState<{
    message: string;
    failed: boolean;
  } | null>(null);
  const copyAttempt = useRef(0);
  const npub = viewer ? npubEncode(viewer) : "";
  async function copyIdentity(value: string, label: string) {
    const attempt = ++copyAttempt.current;
    setCopyStatus(null);
    try {
      await writeClipboardText(value);
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
    <section aria-labelledby="identity-settings-title">
      <Header
        id="identity-settings-title"
        title="Identity"
        subtitle="Your identity is shared across communities. Public keys are safe to share."
      />
      {!viewer && (
        <p>Your identity is unavailable. Connect your identity to manage it.</p>
      )}
      {viewer && (
        <>
          <SettingsGroup>
            {(
              [
                ["Public key (hex)", "Public key", viewer],
                ["Nostr address (npub)", "Nostr address", npub],
              ] as const
            ).map(([label, copyLabel, value]) => (
              <PreferenceRow
                key={label}
                title={label}
                subtitle={
                  <code className={`text-mono ${styles.identityValue}`}>
                    {value}
                  </code>
                }
                trailing={
                  <Tooltip
                    content={`Copy ${copyLabel.toLowerCase()}`}
                    hint="familiar"
                  >
                    <IconButton
                      size="sm"
                      variant="ghost"
                      aria-label={`Copy ${copyLabel.toLowerCase()}`}
                      icon={<CopyIcon aria-hidden="true" />}
                      onClick={() => void copyIdentity(value, copyLabel)}
                    />
                  </Tooltip>
                }
              />
            ))}
          </SettingsGroup>
          {identity && (
            <div className="mt-6">
              <SettingsGroup layout="form">
                {/* One key widget at a time; the dialog brings its own. */}
                {!signingOut && <PrivateKey identity={identity} />}
              </SettingsGroup>
              <SettingsGroup>
                <BackupRow backup={identity.backup} offered={offered} />
                {offered && builderlabIdentity && (
                  <BackedUpKeys
                    viewer={viewer}
                    identity={identity}
                    federated={builderlabIdentity}
                    lastActive={lastActive}
                    onSwitch={(pubkey) => {
                      restoreChoice.set(pubkey);
                      setSigningOut(true);
                    }}
                  />
                )}
                <PreferenceRow
                  title="Sign out of Buzz"
                  subtitle="Remove your private key from this device. Also signs you out of your organization and ends Builderlab and hosted community logins."
                  trailing={
                    <Button type="button" onClick={() => setSigningOut(true)}>
                      Sign out of Buzz
                    </Button>
                  }
                />
              </SettingsGroup>
              {signingOut && (
                <SignOutDialog
                  identity={identity}
                  onClose={() => {
                    restoreChoice.set(undefined);
                    setSigningOut(false);
                  }}
                />
              )}
            </div>
          )}
          {federatedIdentity && (
            <OrganizationSignIn identity={federatedIdentity} />
          )}
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
        </>
      )}
    </section>
  );
}

function OrganizationSignIn({ identity }: { identity: FederatedIdentity }) {
  const state = useSyncExternalStore(
    identity.subscribe,
    identity.snapshot,
    identity.snapshot,
  );
  const [failure, setFailure] = useState("");
  const problem = failure || state.failure;
  if (!state.authority || state.status === "unconfigured") return null;
  // Controls hide when unavailable, but a failed sign-out still explains itself.
  if (state.status === "unavailable")
    return problem ? (
      <p role="alert" className="mt-6 text-body-sm text-danger">
        {recoveryMessage(problem)}
      </p>
    ) : null;
  const organization = new URL(state.authority.identityOrigin).host;
  const signedIn = state.status === "signed-in";
  const signingIn = state.status === "signing-in";
  const expires =
    signedIn && state.expiresAt
      ? new Date(state.expiresAt).toLocaleString(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
        })
      : "";
  function run(operation: () => Promise<unknown>) {
    setFailure("");
    void Promise.resolve()
      .then(operation)
      .catch((error: unknown) =>
        setFailure(
          error instanceof Error ? error.message : "Sign-in unavailable",
        ),
      );
  }
  return (
    <section className="mt-6" aria-labelledby="organization-sign-in-title">
      <InlineHeader
        id="organization-sign-in-title"
        title="Organization sign-in"
      />
      <SettingsGroup>
        <PreferenceRow
          title={
            signedIn
              ? `Signed in as ${state.email ?? "your organization account"}`
              : "Not signed in"
          }
          subtitle={
            <>
              {expires && (
                <>
                  Expires at {expires}
                  <br />
                </>
              )}
              {`Lets you and your agents into communities that require your ${organization} login. Signing out keeps your Buzz key on this device, but you and your agents can’t connect to those communities again until you sign back in.`}
            </>
          }
          trailing={
            <Button
              type="button"
              disabled={state.status === "restoring"}
              onClick={() =>
                run(() =>
                  signedIn
                    ? identity.signOut()
                    : signingIn
                      ? identity.cancelSignIn()
                      : identity.signIn(),
                )
              }
            >
              {signedIn
                ? "Sign out of organization"
                : signingIn
                  ? "Cancel sign-in"
                  : "Sign in"}
            </Button>
          }
        />
        {problem && (
          <p role="alert" className="text-body-sm text-danger">
            {recoveryMessage(problem)}
          </p>
        )}
      </SettingsGroup>
    </section>
  );
}
