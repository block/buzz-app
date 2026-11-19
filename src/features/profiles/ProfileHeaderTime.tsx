import { useManagedProfile } from "./profile-source";
import { useSyncExternalStore } from "react";
import type { RelaySession } from "../relay/session";
import { ProfileLocalTime } from "./ProfileLocalTime";
import type { ManagedProfile } from "./managed-profile";

/** Shared location and local time for full and hover profile headers. */
export function ProfileHeaderTime({
  session,
  pubkey,
  managed: supplied,
}: {
  session: RelaySession;
  pubkey: string;
  managed?: ManagedProfile | undefined;
}) {
  const timeZone = useSyncExternalStore(
    session.profiles.subscribe,
    () => session.profiles.snapshot().get(pubkey)?.tz,
  );
  const providerManaged = useManagedProfile(session, pubkey);
  const managed = supplied ?? providerManaged;
  const location =
    managed?.fields.find((field) => field.key === "location")?.value ||
    managed?.city;
  return (
    <div className="flex flex-col items-center gap-1">
      {location && (
        <span className="text-body-sm text-primary">{location}</span>
      )}
      <ProfileLocalTime
        inlineDetails
        timeZone={timeZone || managed?.timezone}
        className="text-body-sm text-secondary"
      />
    </div>
  );
}
