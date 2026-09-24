import { useEffect, useState, useSyncExternalStore } from "react";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import type { TemplateProviders } from "../../features/channel-templates/provider";
import { Button } from "../../shared/design-system/ui/Button";
import { ChannelGroupsDialog } from "./ChannelGroupsDialog";
import { useSidebarPreferences } from "./useSidebarPreferences";

export function ChannelSetupSettings({
  relay,
  providers,
  active,
}: {
  relay: RelayData;
  providers: TemplateProviders;
  active(): boolean;
}) {
  const connection = useRelayConnection(relay);
  return (
    <section aria-label="Personal groups settings" className="mt-8">
      <h3 className="text-label">Personal groups</h3>
      <p className="text-body-sm text-muted">
        Organize channels privately. Moving a channel never changes its members
        or Canvas.
      </p>
      {connection.status === "ready" ? (
        <GroupSettings
          key={`${connection.scope}:${connection.generation}`}
          session={connection.session}
          providers={providers}
          active={active}
        />
      ) : (
        <p role="status">
          Choose a connected community to manage personal groups.
        </p>
      )}
    </section>
  );
}
function GroupSettings({
  session,
  providers,
  active,
}: {
  session: RelaySession;
  providers: TemplateProviders;
  active(): boolean;
}) {
  const kit = useSyncExternalStore(
    session.channelKit.subscribe,
    session.channelKit.snapshot,
  );
  const preferences = useSidebarPreferences(session.sidebarPreferences);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    session.channelKit.ensure();
  }, [session]);
  return (
    <>
      <Button
        disabled={!session.channelKit.available || kit.status !== "ready"}
        onClick={() => {
          if (active()) setOpen(true);
        }}
      >
        Manage personal groups
      </Button>
      {kit.status !== "ready" && (
        <p role="status">
          {kit.error ?? "Saved groups are not ready."}{" "}
          <Button onClick={() => void session.channelKit.refresh()}>
            Reload groups
          </Button>
        </p>
      )}
      {open && (
        <ChannelGroupsDialog
          open={open}
          onOpenChange={setOpen}
          kit={session.channelKit}
          legacy={preferences.data}
          providers={providers}
          active={active}
        />
      )}
    </>
  );
}
