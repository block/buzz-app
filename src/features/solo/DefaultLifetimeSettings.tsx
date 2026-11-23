import { useState } from "react";
import type { RelaySession } from "../relay/session";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import {
  saveDefaultLifetime,
  useAccountLifetimes,
  useDefaultLifetime,
} from "./default-lifetime";
import { LifetimeSelect } from "./LifetimeSelect";

/** The lifetime new conversations start with, saved to the account as soon
 * as it changes. Workspaces can set their own. */
export function DefaultLifetimeSettings({
  scope,
  session,
}: {
  scope: string;
  session?: RelaySession | undefined;
}) {
  useAccountLifetimes(session, scope);
  const ttlSeconds = useDefaultLifetime(scope);
  const [error, setError] = useState("");
  return (
    <SettingsGroup>
      <LifetimeSelect
        variant="preference"
        label="New conversations"
        description="New conversations start with this lifetime unless their workspace has its own. You can change it in a conversation’s settings."
        value={ttlSeconds ?? null}
        error={error}
        onChange={(value) => {
          setError("");
          void saveDefaultLifetime(session, scope, value ?? undefined).then(
            (failed) => setError(failed ?? ""),
          );
        }}
      />
    </SettingsGroup>
  );
}
