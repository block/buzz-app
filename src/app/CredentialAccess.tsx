import { invoke, isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { Button } from "../shared/design-system/ui/Button";
import { PreferenceRow } from "../shared/design-system/ui/PreferenceRow";
import { SettingsGroup } from "../shared/design-system/ui/SettingsGroup";

export type CredentialGrant = Readonly<{
  consumer: string;
  consumerName: string;
  provider: string;
  providerName: string;
  name: string;
}>;

/**
 * Saved "Always Allow" answers: one plugin using a credential another plugin
 * saved. Revoking makes the next use ask again. `revision` changes whenever
 * the plugin catalog does, because removing a plugin removes its grants.
 */
export function CredentialAccess({ revision }: { revision: unknown }) {
  const [grants, setGrants] = useState<readonly CredentialGrant[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    invoke<CredentialGrant[]>("plugin_secret_grants").then(
      (next) => {
        setGrants(next);
        setError(null);
      },
      (cause) => setError(String(cause)),
    );
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is the reload trigger.
  useEffect(() => {
    if (isTauri()) load();
  }, [load, revision]);
  if (!isTauri() || (grants.length === 0 && !error)) return null;
  return (
    <section aria-labelledby="credential-access-title">
      <h3 id="credential-access-title" className="text-heading">
        Credential access
      </h3>
      {error && (
        <p role="alert" className="error text-body-sm">
          {error}
        </p>
      )}
      <SettingsGroup>
        {grants.map((grant) => (
          <PreferenceRow
            key={`${grant.consumer}\n${grant.provider}\n${grant.name}`}
            title={grant.consumerName}
            subtitle={`Can use “${grant.name}” from ${grant.providerName}`}
            trailing={
              <Button
                type="button"
                aria-label={`Revoke ${grant.consumerName} access to ${grant.name} from ${grant.providerName}`}
                onClick={() =>
                  invoke("plugin_secret_revoke", {
                    consumer: grant.consumer,
                    provider: grant.provider,
                    name: grant.name,
                  }).then(load, (cause) => setError(String(cause)))
                }
              >
                Revoke
              </Button>
            }
          />
        ))}
      </SettingsGroup>
    </section>
  );
}
