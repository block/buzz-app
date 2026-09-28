import { useEffect, useRef, useState } from "react";
import { sameCommunityAgents } from "../../features/agents/choices";
import type { AgentControl, AgentView } from "../../features/agents/control";
import { useAgentControl } from "../../features/agents/control-react";
import type { LocalEvents } from "../../features/relay/outbox";
import type { RelaySession } from "../../features/relay/session";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";

/** Base Buzz agent delete, rendered only for the verified NIP-OA owner. The
 * relay owns membership and archive state and re-authorizes each request; the
 * native controller owns the record and key, removed last. */
export function ProfileAgentDelete({
  session,
  control,
  scope,
  pubkey,
  archive,
  busy,
  beginDelete,
  endDelete,
  onDeleted,
}: {
  session: RelaySession;
  control: AgentControl;
  scope: string;
  pubkey: string;
  busy: boolean;
  beginDelete(): boolean;
  endDelete(): void;
  /** Resolves true once the relay confirms the identity is archived. Starts
   * no new request once `signal` aborts. */
  archive(signal: AbortSignal): Promise<boolean>;
  onDeleted(): void;
}) {
  const state = useAgentControl(control);
  const [confirming, setConfirming] = useState(false);
  // Keep the record's row through the steps that precede its removal.
  const [deleting, setDeleting] = useState<AgentView>();
  const [error, setError] = useState("");
  const run = useRef<AbortController>(undefined);
  // Closing or retargeting the profile cancels any step before native removal
  // and fences every later presentation callback to the originating target.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new target must cancel the old run.
  useEffect(
    () => () => {
      if (run.current) {
        run.current.abort();
        run.current = undefined;
        endDelete();
      }
      setDeleting(undefined);
    },
    [pubkey],
  );
  const matches = sameCommunityAgents(state.data?.agents ?? [], scope).filter(
    (agent) => agent.pubkey === pubkey,
  );
  // Only an unambiguous agent managed here may be deleted; native refuses a
  // deployed remote record, so never start relay effects for one.
  const agent =
    deleting ??
    (matches.length === 1 && !matches[0]?.deployedRemote
      ? matches[0]
      : undefined);
  if (!control.delete || !agent) return null;
  async function remove(target: AgentView) {
    if (!control.delete || run.current || !beginDelete()) return;
    const controller = new AbortController();
    const { signal } = controller;
    run.current = controller;
    setDeleting(target);
    setError("");
    try {
      // Every relay effect is confirmed first; native removal is the only
      // irreversible step, so any earlier failure leaves Delete retryable.
      await removeAgentFromChannels(session, pubkey, signal);
      signal.throwIfAborted();
      // A failed archive shows its own failure text and Archive retry.
      if (!(await archive(signal)) || signal.aborted) return;
      await control.delete(target.id, target.revision);
      if (!signal.aborted) onDeleted();
    } catch (reason) {
      if (!signal.aborted)
        setError(
          reason instanceof Error ? reason.message : "Failed to delete agent.",
        );
    } finally {
      if (run.current === controller) {
        run.current = undefined;
        endDelete();
        setDeleting(undefined);
      }
    }
  }
  return (
    <>
      <div>
        <Button
          size="compact"
          variant="destructive"
          loading={!!deleting}
          disabled={!deleting && (busy || state.busy)}
          onClick={() => setConfirming(true)}
        >
          Delete agent
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-body-sm text-danger">
          {error}
        </p>
      )}
      {confirming && (
        <AlertDialog
          title="Delete this agent?"
          description="Deleting this agent stops and removes the agent from this community."
          onClose={() => setConfirming(false)}
          actions={
            <>
              <Button onClick={() => setConfirming(false)}>Cancel</Button>
              <Button
                variant="destructive"
                onClick={() => {
                  setConfirming(false);
                  void remove(agent);
                }}
              >
                Delete agent
              </Button>
            </>
          }
        >
          <ul className="text-body-sm text-secondary">
            <li>Removes the local management record and saved agent key</li>
            <li>Removes the agent from every channel it belongs to</li>
            <li>
              Archives the agent&apos;s identity on the relay so it no longer
              appears in member lists or mention suggestions
            </li>
            <li>Stops any local agent process before deleting the record</li>
          </ul>
          <p className="text-body-sm text-secondary">
            Archive this agent if you want to hide it instead of removing it.
          </p>
        </AlertDialog>
      )}
    </>
  );
}

/** Base Buzz `removeAgentFromAllChannels` over the relay's rosters for this
 * agent plus the viewer's loaded channels. Resolves only once a fresh relay
 * read lists the agent in none of them; any refusal or unknown outcome throws. */
export async function removeAgentFromChannels(
  session: Pick<RelaySession, "outbox" | "channels" | "workSessions">,
  pubkey: string,
  signal: AbortSignal,
) {
  const pending = new Set([
    ...(await session.workSessions.memberChannels(pubkey, signal)),
    ...session.channels
      .list()
      .channels.filter((channel) => channel.members?.includes(pubkey))
      .map((channel) => channel.id),
  ]);
  if (!pending.size) return;
  const outbox = session.outbox;
  if (!outbox?.supports(9001))
    throw new Error("This community cannot remove agents from channels.");
  await outbox.ready();
  signal.throwIfAborted();
  // Nothing new is signed or published for a cancelled Delete.
  const active = () => !signal.aborted;
  const operations = [...pending].map((id) => {
    const previous = outbox
      .snapshot()
      .find(
        ({ event, delivery }) =>
          delivery !== "accepted" &&
          delivery !== "seen" &&
          event.kind === 9001 &&
          event.tags.some(([name, value]) => name === "h" && value === id) &&
          event.tags.some(([name, value]) => name === "p" && value === pubkey),
      );
    // Retry reuses the outbox's own operation, including an unknown result.
    if (previous) outbox.retry(previous.event.id, active);
    const operation =
      previous?.event.id ??
      outbox.send(
        {
          kind: 9001,
          content: "",
          tags: [
            ["h", id],
            ["p", pubkey],
          ],
        },
        undefined,
        active,
      );
    return operation;
  });
  await Promise.all(operations.map((id) => delivered(outbox, id, signal)));
  // Confirm each channel against its own fresh roster: a cached loaded roster
  // may still list the agent after the relay removed it.
  const listed = await Promise.all(
    [...pending].map((id) =>
      session.workSessions.listsMember(id, pubkey, signal),
    ),
  );
  const remaining = listed.filter(Boolean);
  if (remaining.length)
    throw new Error(
      `The relay did not confirm removal from ${remaining.length} channel${remaining.length === 1 ? "" : "s"}. Retry.`,
    );
  // The rosters confirm the outcome; nothing is left for the outbox to retry.
  await Promise.all(operations.map((id) => outbox.dismiss(id)));
}

function delivered(outbox: LocalEvents, id: string, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    let stop = () => {};
    const finish = (error?: unknown) => {
      stop();
      signal.removeEventListener("abort", cancelled);
      error ? reject(error) : resolve();
    };
    const cancelled = () => finish(signal.reason);
    const inspect = () => {
      const item = outbox.snapshot().find((entry) => entry.event.id === id);
      // Delivery alone is not removal; the caller re-reads the rosters next.
      if (!item || item.delivery === "accepted" || item.delivery === "seen")
        finish();
      else if (item.delivery !== "sending")
        finish(
          new Error(item.error ?? "Channel removal is not confirmed. Retry."),
        );
    };
    stop = outbox.subscribe(inspect);
    signal.addEventListener("abort", cancelled, { once: true });
    if (signal.aborted) cancelled();
    else inspect();
  });
}
