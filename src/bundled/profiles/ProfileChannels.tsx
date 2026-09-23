import type { Navigation } from "../../features/navigation/controller";
import { useChannelList } from "../../features/relay/react";
import type { RelaySession } from "../../features/relay/session";
import { Button } from "../../shared/design-system/ui/Button";

/** Only the viewer's listed channels with an exact roster match are evidence. */
export function ProfileChannels({
  session,
  pubkey,
  communityOrigin,
  viewer,
  navigation,
}: {
  session: RelaySession;
  pubkey: string;
  communityOrigin: string | undefined;
  viewer: string | undefined;
  navigation: Navigation | undefined;
}) {
  const list = useChannelList(session.channels);
  const channels = (
    list.status === "ready" || list.status === "error" ? list.channels : []
  ).filter(
    (channel) =>
      !channel.archived &&
      !channel.hidden &&
      channel.channelType !== "dm" &&
      channel.channelType !== "session" &&
      channel.members?.includes(pubkey),
  );
  return (
    <section aria-label="Visible channels" className="flex flex-col gap-2">
      <h3 className="m-0 text-heading">Visible channels</h3>
      <p className="m-0 text-body-sm text-secondary">
        Channels you can see where this exact identity is a member.
      </p>
      {(list.status === "idle" || list.status === "loading") && (
        <p role="status">Loading channels…</p>
      )}
      {list.status === "unavailable" && (
        <p>Channel membership is unavailable.</p>
      )}
      {list.status === "error" && (
        <div>
          <p role="alert">Could not finish loading visible channels.</p>
          <Button
            size="compact"
            onClick={() => session.channels.refreshList?.()}
          >
            Retry channels
          </Button>
        </div>
      )}
      {list.status === "ready" && !channels.length && (
        <p>
          {list.coverage === "partial"
            ? "No matching channels in the loaded list; more channels may exist."
            : "No visible channels with verified membership for this identity."}
        </p>
      )}
      {!!channels.length && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {channels.map((channel) => (
            <li key={channel.id}>
              {communityOrigin && navigation && viewer ? (
                <Button
                  size="compact"
                  variant="ghost"
                  onClick={() =>
                    void navigation.open({
                      version: 1,
                      kind: "conversation",
                      channelId: channel.id,
                      scope: { viewer, communityOrigin },
                    })
                  }
                >
                  #{channel.name}
                </Button>
              ) : (
                <span>{channel.name}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {list.coverage === "partial" && !!channels.length && (
        <p className="text-body-sm text-secondary">
          More channels may exist outside the loaded list.
        </p>
      )}
      {channels.length > 0 && (!communityOrigin || !navigation) && (
        <p className="text-body-sm text-secondary">
          Channel navigation is unavailable here.
        </p>
      )}
    </section>
  );
}
