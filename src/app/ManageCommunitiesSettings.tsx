import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Communities, Membership } from "../features/communities/service";
import { communityDestination } from "../features/communities/destination";
import {
  communityActionLabel,
  communityName,
} from "../features/communities/names";
import {
  deviceRemovalFailureText,
  removeCommunityFromDevice,
  removedFromDeviceText,
} from "../features/communities/departure";
import { AlertDialog } from "../shared/design-system/ui/AlertDialog";
import { Button } from "../shared/design-system/ui/Button";
import { Header } from "../shared/design-system/ui/Header";
import { PreferenceRow } from "../shared/design-system/ui/PreferenceRow";
import { SettingsGroup } from "../shared/design-system/ui/SettingsGroup";
import { useToastNotification } from "../shared/design-system/ui/Toast";

/** Device inventory, independent of the selected community and its connection. */
export function ManageCommunitiesSettings({
  communities,
}: {
  communities: Communities;
}) {
  const client = useSyncExternalStore(
    communities.subscribe,
    communities.snapshot,
  );
  const [removing, setRemoving] = useState<Membership | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const mounted = useRef(false);
  const list = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const notify = useToastNotification();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const remove = async () => {
    if (!removing || busy.current) return;
    const viewer = client.viewer;
    busy.current = true;
    setPending(true);
    try {
      const result = await removeCommunityFromDevice(communities, removing);
      if (communities.snapshot().viewer === viewer)
        notify(
          removedFromDeviceText(
            communityActionLabel(removing),
            result.residue.length > 0,
          ),
          "success",
        );
    } catch (error) {
      if (communities.snapshot().viewer === viewer)
        notify(
          deviceRemovalFailureText(communityActionLabel(removing), error),
          "error",
        );
    } finally {
      busy.current = false;
      if (mounted.current) {
        setPending(false);
        setRemoving(null);
      }
    }
  };
  return (
    <section aria-labelledby="manage-communities-title">
      <Header
        id="manage-communities-title"
        title="Manage communities"
        subtitle="Remove communities from Buzz on this device. Saved drafts and local data are deleted. Your membership won’t change."
      />
      <section ref={list} tabIndex={-1} aria-label="Saved communities">
        <SettingsGroup>
          <PreferenceRow
            title="Personal space"
            subtitle="Always available on this device."
          />
          {client.memberships.map((membership) => (
            <PreferenceRow
              key={membership.id}
              title={communityName(membership)}
              subtitle={
                <span className="break-all">
                  {communityDestination(membership.id).url}
                </span>
              }
              trailing={
                <Button
                  disabled={pending}
                  aria-label={`Remove ${communityActionLabel(membership)} from this device`}
                  onClick={(event) => {
                    trigger.current = event.currentTarget;
                    setRemoving(membership);
                  }}
                >
                  Remove from this device
                </Button>
              }
            />
          ))}
        </SettingsGroup>
      </section>
      {removing && (
        <AlertDialog
          title={`Remove ${communityName(removing)} from this device?`}
          description="The community connection and any saved drafts or data will be removed from Buzz on this device. Your membership won’t change. You can add it again later."
          pending={pending}
          initialFocus={cancel}
          finalFocus={() =>
            trigger.current?.isConnected ? trigger.current : list.current
          }
          onClose={() => setRemoving(null)}
          actions={
            <>
              <Button
                ref={cancel}
                disabled={pending}
                onClick={() => setRemoving(null)}
              >
                Cancel
              </Button>
              <Button
                variant="prominent"
                loading={pending}
                onClick={() => void remove()}
              >
                Remove from this device
              </Button>
            </>
          }
        >
          <p className="break-all text-body-sm">
            {communityDestination(removing.id).url}
          </p>
        </AlertDialog>
      )}
    </section>
  );
}
