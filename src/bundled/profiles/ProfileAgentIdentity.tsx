import type { PanelProps } from "../../features/panels/service";
import { profileTarget } from "../../features/profiles/target";
import type { RelaySession } from "../../features/relay/session";
import { Button } from "../../shared/design-system/ui/Button";
import styles from "./Profiles.module.css";
import { useProfileName } from "./useProfileName";

export function ProfileAgentIdentity({
  session,
  owner,
  viewer,
  context,
}: {
  session: RelaySession;
  owner: string;
  viewer: string | undefined;
  context: PanelProps["context"];
}) {
  return (
    <section aria-label="Agent identity" className={styles.agentIdentity}>
      <h3 className="text-body">Managed by</h3>
      <OwnerLink
        session={session}
        owner={owner}
        self={owner === viewer}
        context={context}
      />
    </section>
  );
}

function OwnerLink({
  session,
  owner,
  self,
  context,
}: {
  session: RelaySession;
  owner: string;
  self: boolean;
  context: PanelProps["context"];
}) {
  const shown = useProfileName(session, owner);
  const name = self ? `${shown} (you)` : shown;
  const target = profileTarget(owner);
  return (
    <div>
      {target && context?.canOpen(target) ? (
        <Button
          size="compact"
          variant="ghost"
          aria-label={`Open owner profile: ${name}`}
          onClick={() => (context.push ?? context.open)(target)}
        >
          {name}
        </Button>
      ) : (
        name
      )}
    </div>
  );
}
