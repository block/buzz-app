import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { ManagedProfile } from "../../features/profiles/managed-profile";
import type { RelaySession } from "../../features/relay/session";
import { writeClipboardText } from "../../shared/clipboard";
import {
  ArrowUpRightIcon,
  CopyIcon,
  CheckIcon,
  InfoIcon,
  AtIcon,
  EnvelopeIcon,
  UsersIcon,
  UserCircleIcon,
  ClockIcon,
  HashIcon,
} from "../../shared/design-system/icons";
import {
  abbreviatedPublicKey,
  typedPublicKey,
} from "../../shared/identity/public-key";
import { avatarMedia } from "../../shared/avatar-source";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { resolveProviderProfile } from "./provider-profile";
import { ProviderProfileRow } from "./ProviderProfileRow";
import { ProfileLocationPreview } from "./ProfileLocationPreview";
import styles from "./ProfileInfoBento.module.css";
import { InlineHeader } from "../../shared/design-system/ui/Header";

function LeadPhoto({
  username,
  session,
  name,
}: {
  username: string;
  session: RelaySession;
  name: string;
}) {
  const [resolved, setResolved] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    setResolved(undefined);
    void resolveProviderProfile(session, username, controller.signal)
      .then(async (pubkey) => {
        await session.profiles.ensure([pubkey], "background");
        if (!controller.signal.aborted) setResolved(pubkey);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [session, username]);
  const profile = useSyncExternalStore(session.profiles.subscribe, () =>
    resolved ? session.profiles.snapshot().get(resolved) : undefined,
  );
  const picture =
    profile?.verified?.status === "checked" &&
    profile.verified.username === username
      ? profile.picture
      : undefined;
  return (
    <span className={styles.leadPhoto}>
      <Avatar
        src={avatarMedia(picture, session.media)}
        alt=""
        fallback={name}
        size="fill"
      />
    </span>
  );
}

function CopyTile({
  label,
  value,
  displayValue = value,
  icon,
}: {
  label: string;
  value: string;
  displayValue?: string;
  icon: ReactNode;
}) {
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");
  useEffect(() => {
    if (status !== "copied") return;
    const timer = setTimeout(() => setStatus("idle"), 1500);
    return () => clearTimeout(timer);
  }, [status]);
  return (
    <button
      type="button"
      className={`${styles.tile} ${styles.copyTile}`}
      aria-label={`Copy ${label.toLowerCase()}`}
      onClick={() => {
        setStatus("idle");
        void writeClipboardText(value).then(
          () => setStatus("copied"),
          () => setStatus("error"),
        );
      }}
    >
      <span className={styles.icon}>{icon}</span>
      <span className={styles.content}>
        <span className={styles.label}>
          <span className="text-body">{label}</span>
        </span>
        <span className={`${styles.value} text-body-sm`}>{displayValue}</span>
      </span>
      <span className={styles.copyAction}>
        <span
          className={status === "error" ? "text-caption" : "sr-only"}
          role="status"
        >
          {status === "copied"
            ? "Copied"
            : status === "error"
              ? "Copy failed — try again"
              : "Copy"}
        </span>
        {status === "copied" ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
      </span>
    </button>
  );
}

export function ProfileInfoBento({
  picture,
  managed,
  npub,
  username,
  about,
  timeZone,
  session,
  open,
}: {
  picture: string | undefined;
  managed: ManagedProfile;
  npub: string;
  username: string | undefined;
  about: string | undefined;
  timeZone: string | undefined;
  session: RelaySession;
  open: ((target: string) => unknown) | undefined;
}) {
  const fields = managed.fields;
  const team = fields.find((field) => field.key === "team");
  const lead = fields.find((field) => field.key === "lead");
  const tenure = fields.find((field) => field.key === "tenure");
  const email = fields.find((field) => field.key === "email");
  const row = (label: string, value: string, icon: ReactNode) => (
    <div className={styles.tile}>
      <span className={styles.icon}>{icon}</span>
      <div className={styles.content}>
        <div className={`${styles.label} text-body`}>{label}</div>
        <div className={`${styles.value} text-body-sm`}>{value}</div>
      </div>
    </div>
  );
  const extraFields = (section: "personal" | "team" | "location") =>
    fields
      .filter(
        (field) =>
          field.section === section &&
          !["username", "team", "lead", "tenure", "email", "location"].includes(
            field.key,
          ),
      )
      .map((field) =>
        field.username && open ? (
          <ProviderProfileRow
            key={field.key}
            title={field.label}
            value={field.value}
            username={field.username}
            session={session}
            open={open}
          />
        ) : (
          <div key={field.key}>
            {row(field.label, field.value, <InfoIcon size={24} />)}
          </div>
        ),
      );
  const leadContent = lead && (
    <>
      <span className={styles.icon}>
        {lead.username ? (
          <LeadPhoto
            key={lead.username}
            username={lead.username}
            session={session}
            name={lead.value}
          />
        ) : (
          <UsersIcon size={24} />
        )}
      </span>
      <div className={styles.content}>
        <div className={`${styles.label} text-body`}>{lead.label}</div>
        <div className={`${styles.value} text-body-sm`}>{lead.value}</div>
      </div>
      {lead.username && open && <ArrowUpRightIcon size={16} />}
    </>
  );
  return (
    <section className={styles.grid} aria-label="Profile information">
      <section aria-label="Personal info">
        <InlineHeader title="Personal info" />
        <div className={styles.group}>
          {about && row("About", about, <UserCircleIcon size={24} />)}
          {username && row("Username", `@${username}`, <AtIcon size={24} />)}
          {extraFields("personal")}
          {email?.value && (
            <CopyTile
              key={email.value}
              label={email.label}
              value={email.value}
              icon={<EnvelopeIcon size={24} />}
            />
          )}
        </div>
      </section>
      {(team || lead || tenure || extraFields("team").length > 0) && (
        <section aria-label="Team">
          <InlineHeader title="Team" />
          <div className={styles.group}>
            {extraFields("team")}
            {team && row(team.label, team.value, <UsersIcon size={24} />)}
            {lead ? (
              lead.username && open ? (
                <ProviderProfileRow
                  title={lead.label}
                  value={lead.value}
                  username={lead.username}
                  session={session}
                  open={open}
                  className={styles.tile}
                >
                  {leadContent}
                </ProviderProfileRow>
              ) : (
                <div className={styles.tile}>{leadContent}</div>
              )
            ) : null}
            {tenure && row(tenure.label, tenure.value, <ClockIcon size={24} />)}
          </div>
        </section>
      )}
      {(fields.find((field) => field.key === "location")?.value ||
        managed.city ||
        managed.timezone ||
        timeZone ||
        extraFields("location").length > 0) && (
        <section aria-label="Location">
          <InlineHeader title="Location" />
          {extraFields("location").length > 0 && (
            <div className={styles.group}>{extraFields("location")}</div>
          )}
          <ProfileLocationPreview
            picture={picture}
            coordinates={managed.coordinates}
            location={
              fields.find((field) => field.key === "location")?.value ||
              managed.city
            }
            timeZone={managed.timezone ?? timeZone}
          />
        </section>
      )}
      <section className={styles.group} aria-label="Public key">
        <CopyTile
          key={npub}
          label="Public key"
          value={npub}
          displayValue={
            abbreviatedPublicKey(typedPublicKey(npub) ?? "", 5) ?? npub
          }
          icon={<HashIcon size={24} />}
        />
      </section>
    </section>
  );
}
