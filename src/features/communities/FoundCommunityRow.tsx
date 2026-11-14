import { Avatar } from "../../shared/design-system/ui/Avatar";
import { communityName } from "./community-name";
import type { FoundCommunity } from "./find-community";

/**
 * A found community as its lookup names it, before anyone has joined: the
 * icon when the relay publishes one, its name, and under it the address the
 * page shows, unless that only repeats the name.
 */
export function FoundCommunityRow({
  found,
  address,
}: {
  found: Pick<FoundCommunity, "host" | "name" | "icon">;
  address: string;
}) {
  const name = communityName(found.name, found.host);
  return (
    <div className="flex items-center gap-3 rounded-[var(--radius-row)] bg-surface-inset p-4">
      <Avatar
        alt=""
        fallback={name}
        fallbackSurface="panel"
        src={found.icon}
        shape="squircle"
        size="large"
      />
      <div className="min-w-0 flex-1">
        <p className="m-0 break-words text-body text-standard">{name}</p>
        {address !== name && (
          <p className="m-0 break-all text-body text-subtle">{address}</p>
        )}
      </div>
    </div>
  );
}
