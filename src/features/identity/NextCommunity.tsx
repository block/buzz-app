import type { FoundCommunity } from "../communities/find-community";
import { FoundCommunityRow } from "../communities/FoundCommunityRow";

/**
 * The community first run holds to join once the page showing is behind it:
 * named as the step after, so signing in, setup and joining read as separate
 * steps and a pause or failure still shows the invite. The row is the one
 * Join Community uses, with whatever of the lookup's answer first run kept.
 */
export function NextCommunity({
  community,
  failed = false,
}: {
  community: Pick<FoundCommunity, "host" | "name" | "icon">;
  /** Setup stopped on a failure, so nothing here comes next by itself. */
  failed?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="m-0 text-body text-subtle">
        {failed
          ? "After setup, you’ll join this community."
          : "Next, you’ll join this community."}
      </p>
      <FoundCommunityRow found={community} address={community.host} />
    </div>
  );
}
