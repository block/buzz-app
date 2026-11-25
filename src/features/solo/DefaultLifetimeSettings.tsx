import { useState } from "react";
import type { RelaySession } from "../relay/session";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import {
  saveDefaultLifetime,
  saveDefaultVisibility,
  useAccountLifetimes,
  useDefaultLifetime,
  useDefaultVisibility,
} from "./default-lifetime";
import { LifetimeSelect } from "./LifetimeSelect";
import { VisibilitySelect } from "./VisibilitySelect";

/** The lifetime and visibility new conversations start with, saved to the
 * account as soon as they change. Workspaces can set their own. */
export function DefaultLifetimeSettings({
  scope,
  session,
}: {
  scope: string;
  session?: RelaySession | undefined;
}) {
  useAccountLifetimes(session, scope);
  const ttlSeconds = useDefaultLifetime(scope);
  const visibility = useDefaultVisibility(scope);
  const [error, setError] = useState("");
  const [visibilityError, setVisibilityError] = useState("");
  return (
    <SettingsGroup>
      <LifetimeSelect
        variant="preference"
        label="Lifetime for new conversations"
        description="Unless their workspace has its own. You can change it in a conversation’s settings."
        value={ttlSeconds ?? null}
        error={error}
        onChange={(value) => {
          setError("");
          void saveDefaultLifetime(session, scope, value ?? undefined).then(
            (failed) => setError(failed ?? ""),
          );
        }}
      />
      <VisibilitySelect
        variant="preference"
        label="Visibility for new conversations"
        description="Unless their workspace has its own. You can change it in a conversation’s settings."
        value={visibility}
        error={visibilityError}
        onChange={(value) => {
          if (!value) return;
          setVisibilityError("");
          void saveDefaultVisibility(session, scope, value).then((failed) =>
            setVisibilityError(failed ?? ""),
          );
        }}
      />
    </SettingsGroup>
  );
}
