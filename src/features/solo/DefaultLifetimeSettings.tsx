import { useState } from "react";
import { ChannelDurationField } from "../../bundled/channels/ChannelDurationField";
import { DEFAULT_TEMPORARY_CHANNEL_TTL_SECONDS } from "../relay/channel-writes";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { useDefaultLifetime, writeDefaultLifetime } from "./default-lifetime";

/** The lifetime new Solo chats start with, saved as soon as it changes. */
export function DefaultLifetimeSettings({ scope }: { scope: string }) {
  const ttlSeconds = useDefaultLifetime(scope);
  // The duration shown while Ongoing, so switching back keeps it.
  const [duration, setDuration] = useState(
    ttlSeconds ?? DEFAULT_TEMPORARY_CHANNEL_TTL_SECONDS,
  );
  const [error, setError] = useState("");
  return (
    <SettingsGroup layout="form">
      <ChannelDurationField
        label="New Solo chats"
        description="Each chat you start begins with this lifetime. Change one chat’s lifetime in its settings."
        temporary={ttlSeconds !== undefined}
        ttlSeconds={ttlSeconds ?? duration}
        error={error || undefined}
        onChange={(next) => {
          if (next !== undefined) setDuration(next);
          setError(
            writeDefaultLifetime(scope, next)
              ? ""
              : "Couldn’t save this on this device. Try again.",
          );
        }}
      />
    </SettingsGroup>
  );
}
