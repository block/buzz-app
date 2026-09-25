import { useState } from "react";
import { useChannelIdentityNames } from "../../features/identity-names/react";
import type { RelaySession } from "../../features/relay/session";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Select } from "../../shared/design-system/ui/Select";
import { ProfileMemories } from "../profiles/ProfileMemories";

/** Choose a channel member, not a separate native/legacy agent inventory.
 * The existing owner-view memory reader decides which entries are readable. */
export function BestieMemories({
  session,
  channelId,
  members,
}: {
  session: RelaySession;
  channelId: string;
  members: readonly string[];
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState("");
  const [revision, setRevision] = useState(0);
  const name = useChannelIdentityNames(session, channelId);
  const candidates = members.filter((key) => key !== session.viewer);
  const pubkey = candidates.includes(selected)
    ? selected
    : candidates.length === 1
      ? candidates[0]
      : undefined;
  return (
    <>
      <Button
        size="compact"
        variant="ghost"
        disabled={!candidates.length}
        onClick={() => setOpen(true)}
      >
        Memories
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Bestie memories"
        description="Read the memories saved on this community’s relay. These are memory documents, separate from workspace files."
        closeLabel="Close memories"
        actions={
          <Button
            size="compact"
            disabled={!pubkey}
            onClick={() => setRevision((value) => value + 1)}
          >
            Refresh memories
          </Button>
        }
      >
        {open && (
          <div className="flex min-w-0 flex-col gap-3">
            {candidates.length > 1 && (
              <Select
                label="Whose memories"
                value={pubkey ?? ""}
                placeholder="Choose a channel member"
                onValueChange={setSelected}
                groups={[
                  {
                    label: "Channel members",
                    options: candidates.map((key) => ({
                      value: key,
                      label: name(key, key.slice(0, 12)),
                    })),
                  },
                ]}
              />
            )}
            {pubkey ? (
              <>
                <p className="text-body-sm text-secondary">
                  {name(pubkey, pubkey.slice(0, 12))}
                </p>
                <ProfileMemories
                  key={`${pubkey}:${revision}`}
                  session={session}
                  pubkey={pubkey}
                />
              </>
            ) : (
              <p>Choose a member to read memories available to your account.</p>
            )}
          </div>
        )}
      </Dialog>
    </>
  );
}
