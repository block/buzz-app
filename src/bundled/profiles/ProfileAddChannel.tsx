import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { sameCommunityAgents } from "../../features/agents/choices";
import type { AgentControl } from "../../features/agents/control";
import type { ChannelList } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { CaretRightIcon } from "../../shared/design-system/icons/index";

/** Admission is available only for an exact native-managed agent in this community. */
export function ProfileAddChannel({
  session,
  pubkey,
  scope,
  control,
  list,
}: {
  session: RelaySession;
  pubkey: string;
  scope: string;
  control: AgentControl;
  list: ChannelList;
}) {
  const nativeState = useSyncExternalStore(
    control.subscribe,
    control.snapshot,
    control.snapshot,
  );
  useSyncExternalStore(
    session.agentChoices.subscribe,
    session.agentChoices.snapshot,
    session.agentChoices.snapshot,
  );
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const eligible = (id?: string, requireNonmember = true) => {
    const native = control.snapshot();
    const list = session.channels.list();
    const choices = session.agentChoices.snapshot();
    return (
      mounted.current &&
      native.status === "ready" &&
      sameCommunityAgents(native.data?.agents ?? [], scope).some(
        (agent) => agent.pubkey === pubkey,
      ) &&
      session.scope === scope &&
      session.workSessions.available &&
      (list.status === "ready" || list.status === "error") &&
      choices.identities.some(
        (agent) => agent.pubkey === pubkey && agent.managed,
      ) &&
      (!id ||
        !!list.channels.find(
          (channel) =>
            channel.id === id &&
            !channel.archived &&
            !channel.hidden &&
            !channel.readOnly &&
            (channel.channelType === "stream" ||
              channel.channelType === "forum") &&
            channel.members &&
            (!requireNonmember || !channel.members.includes(pubkey)),
        ))
    );
  };
  const available = eligible();
  if (!available && !open) return null;
  const candidates = available
    ? list.channels.filter((channel) => eligible(channel.id))
    : [];
  const selectedChannel = candidates.find((channel) => channel.id === selected);
  return (
    <>
      {(available || open) && (
        <Button
          variant="ghost"
          disabled={!available}
          data-profile-channel-link=""
          onClick={() => {
            setError("");
            setSelected("");
            setOpen(true);
          }}
        >
          <span>Add to channel</span>
          <CaretRightIcon size={16} aria-hidden="true" />
        </Button>
      )}
      <Dialog
        open={open}
        onOpenChange={setOpen}
        preventClose={pending}
        title="Add agent to channel"
        description="Choose a channel to add this managed agent. The relay must authorize membership."
        actions={
          <>
            <Button
              variant="ghost"
              disabled={pending}
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button
              disabled={pending || !selectedChannel || !available}
              onClick={() => {
                if (!selectedChannel || pending || !available) return;
                const id = selectedChannel.id;
                // Membership becoming true after submission is success, not revocation.
                const active = () => eligible(id, false);
                setPending(true);
                setError("");
                void (async () => {
                  await control.refresh();
                  if (!active())
                    throw new DOMException(
                      "Channel addition cancelled",
                      "AbortError",
                    );
                  await session.workSessions.addAgents(id, [pubkey], active);
                })()
                  .then(
                    () => {
                      if (mounted.current) {
                        setOpen(false);
                        setSelected("");
                      }
                    },
                    (reason: unknown) => {
                      if (mounted.current)
                        setError(
                          reason instanceof Error &&
                            reason.name !== "AbortError"
                            ? reason.message
                            : "Channel addition cancelled. Check membership before retrying.",
                        );
                    },
                  )
                  .finally(() => {
                    if (mounted.current) setPending(false);
                  });
              }}
            >
              {pending ? "Adding…" : "Add to channel"}
            </Button>
          </>
        }
      >
        <label htmlFor="profile-add-channel">Channel</label>
        <select
          id="profile-add-channel"
          className="buzz-input"
          value={selected}
          disabled={pending || !available}
          onChange={(event) => {
            setSelected(event.target.value);
            setError("");
          }}
        >
          <option value="">Choose a channel</option>
          {candidates.map((channel) => (
            <option key={channel.id} value={channel.id}>
              #{channel.name}
            </option>
          ))}
        </select>
        {list.status !== "ready" && (
          <p>
            Channel discovery is incomplete; only loaded channels are offered.
          </p>
        )}
        {nativeState.status === "error" && (
          <div>
            <p role="alert">
              Could not refresh local agents. Retry to get current host status.
            </p>
            <Button
              size="compact"
              disabled={pending}
              onClick={() => void control.refresh()}
            >
              Retry agents
            </Button>
          </div>
        )}
        {!available && nativeState.status !== "error" && !pending && (
          <p role="alert">
            This agent or channel is no longer eligible. Check its status before
            adding again.
          </p>
        )}
        {!candidates.length && available && (
          <p>No eligible channels in the loaded list.</p>
        )}
        {error && <p role="alert">{error}</p>}
      </Dialog>
    </>
  );
}
