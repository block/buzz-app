import { useRef, useState } from "react";
import type { RelaySession } from "../relay/session";
import { canAddMembers } from "../channel-members/members";
import type { MentionRecipient } from "./mention-draft";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Button } from "../../shared/design-system/ui/Button";

type Pending = {
  people: readonly MentionRecipient[];
  signal: AbortSignal;
  current(): boolean;
  finish(references: readonly string[] | null): void;
  busy: boolean;
  error?: string;
};

/** One consent decision for a captured send. The session owns durable additions. */
export function useNonmemberMentions(
  session: RelaySession,
  channelId: string,
  restoreFocus: () => void,
) {
  const [pending, setPending] = useState<Pending>();
  const adding = useRef(false);
  const channel = session.channels
    .list()
    .channels.find((item) => item.id === channelId);
  const canAdd = !!channel && canAddMembers(session, channel);
  async function add() {
    if (!pending || adding.current || !canAdd) return;
    adding.current = true;
    const request = pending;
    const check = () => {
      request.signal.throwIfAborted();
      if (!request.current())
        throw new Error("The draft changed. Close this dialog and send again.");
    };
    setPending({ ...request, busy: true });
    try {
      for (const person of request.people) {
        check();
        await session.memberAdditions.add(channelId, person.pubkey, undefined, {
          startAgent: false,
        });
      }
      check();
      request.finish([]);
    } catch (reason) {
      if (!request.signal.aborted)
        setPending({
          ...request,
          busy: false,
          error: reason instanceof Error ? reason.message : String(reason),
        });
    } finally {
      adding.current = false;
    }
  }
  return {
    prepare(
      people: readonly MentionRecipient[],
      signal: AbortSignal,
      current: () => boolean,
    ) {
      signal.throwIfAborted();
      return new Promise<readonly string[] | null>((resolve) => {
        const finish = (references: readonly string[] | null) => {
          signal.removeEventListener("abort", abort);
          setPending(undefined);
          resolve(references);
        };
        const abort = () => finish(null);
        signal.addEventListener("abort", abort, { once: true });
        setPending({ people, signal, current, finish, busy: false });
      });
    },
    dialog: (
      <Dialog
        open={!!pending}
        onOpenChange={(open) => {
          if (!open) pending?.finish(null);
        }}
        title="Mention people outside this channel?"
        description="Add them to give them access to channel history and notify them. Do nothing sends a reference without adding or notifying them."
        preventClose={!!pending?.busy}
        finalFocus={() => {
          restoreFocus();
          return false;
        }}
        actions={
          <>
            <Button
              type="button"
              disabled={pending?.busy}
              onClick={() => pending?.finish(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={pending?.busy}
              onClick={() =>
                pending?.finish(pending.people.map((person) => person.pubkey))
              }
            >
              Do nothing
            </Button>
            <Button
              type="button"
              disabled={!canAdd || pending?.busy}
              onClick={() => void add()}
            >
              Add to channel
            </Button>
          </>
        }
      >
        <ul>
          {pending?.people.map((person) => (
            <li key={person.pubkey}>{person.name}</li>
          ))}
        </ul>
        {!canAdd && (
          <p>
            You cannot add people to this channel. You can still send
            references.
          </p>
        )}
        {pending?.busy && <p role="status">Adding people to this channel…</p>}
        {pending?.error && (
          <p role="alert">
            {pending.error} Your draft is kept. Some people may already have
            been added.
          </p>
        )}
      </Dialog>
    ),
  };
}
