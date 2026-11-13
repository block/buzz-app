import { useRef, useState } from "react";
import type { MentionRecipient } from "./mention-draft";
import type { ComposerSession } from "./composer-session";
import type { ChannelSummary } from "../relay/contracts";
import { canAddMembers } from "../channel-members/members";
import { canManageMember } from "../channel-members/administration-protocol";
import { administerMember } from "../channel-members/administration";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Button } from "../../shared/design-system/ui/Button";

/** An agent a draft addresses that cannot reply where it is sent. */
export type UnheardAgent = MentionRecipient & {
  reason: "viewing-only" | "not-in-channel";
  own: boolean;
};
/** `joined`: the agent can now post here, so the draft sends as written. */
export type UnheardChoice = "send" | "solo" | "joined" | null;

export type UnheardOffer = {
  agents: readonly UnheardAgent[];
  /** The channel's name, without `#`. */
  channel: string;
  /** Offer to ask the agent in a new Solo chat instead. */
  solo: boolean;
  /** Lets the agent post here: resolves once the relay confirms it. Absent
   * when the viewer can't change the agent's membership here. */
  join?: ((signal: AbortSignal) => Promise<void>) | undefined;
  /** Whether the captured draft is still the one being sent. */
  current(): boolean;
};

type Pending = UnheardOffer & {
  signal: AbortSignal;
  finish(choice: UnheardChoice): void;
  busy: boolean;
  error?: string | undefined;
};

/** Before a send reaches agents that can't answer here, offer to let the agent
 * post here first, or to ask it in a new Solo chat. Sending here stays
 * available and unchanged. */
export function useGuestAgentMentions(restoreFocus: () => void) {
  const [pending, setPending] = useState<Pending>();
  const joining = useRef(false);
  async function join() {
    const request = pending;
    if (!request?.join || joining.current) return;
    joining.current = true;
    setPending({ ...request, busy: true, error: undefined });
    try {
      await request.join(request.signal);
      request.signal.throwIfAborted();
      if (!request.current())
        throw new Error("The draft changed. Close this dialog and send again.");
      request.finish("joined");
    } catch (reason) {
      if (!request.signal.aborted)
        setPending({
          ...request,
          busy: false,
          error: reason instanceof Error ? reason.message : String(reason),
        });
    } finally {
      joining.current = false;
    }
  }
  const only = pending?.agents.length === 1 ? pending.agents[0] : undefined;
  const joinLabel =
    only?.reason === "not-in-channel"
      ? pending?.busy
        ? "Adding…"
        : "Add to channel and send"
      : pending?.busy
        ? "Making member…"
        : "Make member and send";
  return {
    prepare(offer: UnheardOffer, signal: AbortSignal) {
      signal.throwIfAborted();
      return new Promise<UnheardChoice>((resolve) => {
        const finish = (choice: UnheardChoice) => {
          signal.removeEventListener("abort", abort);
          setPending(undefined);
          resolve(choice);
        };
        const abort = () => finish(null);
        signal.addEventListener("abort", abort, { once: true });
        setPending({ ...offer, signal, finish, busy: false });
      });
    },
    dialog: (
      <Dialog
        size="compact"
        open={!!pending}
        onOpenChange={(open) => {
          if (!open) pending?.finish(null);
        }}
        title={pending ? title(pending.agents) : ""}
        description={pending && describe(pending)}
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
              onClick={() => pending?.finish("send")}
            >
              Send here anyway
            </Button>
            {pending?.solo && (
              <Button
                type="button"
                variant={pending.join ? "subtle" : "prominent"}
                disabled={pending.busy}
                onClick={() => pending.finish("solo")}
              >
                Ask in a Solo chat
              </Button>
            )}
            {pending?.join && (
              <Button
                type="button"
                variant="prominent"
                disabled={pending.busy}
                onClick={() => void join()}
              >
                {joinLabel}
              </Button>
            )}
          </>
        }
      >
        {pending?.error ? (
          <p role="alert">{pending.error} Your draft is kept.</p>
        ) : null}
      </Dialog>
    ),
  };
}

function title(agents: readonly UnheardAgent[]) {
  return agents.length === 1
    ? `${agents[0]?.name} can’t reply here`
    : "These agents can’t reply here";
}

function describe({ agents, channel, solo, join }: UnheardOffer) {
  const [only] = agents;
  if (agents.length !== 1 || !only)
    return `${agents.map((agent) => agent.name).join(", ")} can read #${channel} but can’t post here, or aren’t in it.`;
  const why =
    only.reason === "viewing-only"
      ? `${only.name} is viewing only in #${channel}`
      : `${only.name} isn’t in #${channel}`;
  const fix =
    only.reason === "viewing-only"
      ? "Make it a member so it can reply here"
      : "Add it to the channel so it can reply here";
  if (join)
    return solo
      ? `${why}. ${fix}, or ask it in a Solo chat.`
      : `${why}. ${fix}.`;
  const dm = only.reason === "viewing-only" && only.own;
  return solo
    ? `${why}${dm ? ", so it answers you in your DM" : ""}. Ask in a Solo chat to start a private conversation that links back here.`
    : `${why}.`;
}

const unconfirmed =
  "This change may have taken effect. Open Members to check it before you send again.";

/** How the viewer can let their own `agent` post in `channel`, or nothing
 * when they can't. Someone else's agent is its owner's call, so it gets
 * nothing here: a Viewing-only agent becomes a member through the members panel's
 * role change; an agent outside the channel is added like Invite. Each resolves
 * only once the relay's roster shows the change. */
export function joinOffer(
  session: Pick<
    ComposerSession,
    "viewer" | "outbox" | "memberAdministration" | "memberAdditions"
  >,
  channel: ChannelSummary,
  agent: UnheardAgent,
): ((signal: AbortSignal) => Promise<void>) | undefined {
  if (!agent.own) return undefined;
  if (agent.reason === "not-in-channel")
    return canAddMembers(session, channel)
      ? () => session.memberAdditions.add(channel.id, agent.pubkey)
      : undefined;
  const roles = session.memberAdministration;
  const viewer = session.viewer;
  const run = roles?.run;
  if (
    !roles ||
    !run ||
    !viewer ||
    !canManageMember(roles.snapshot(channel.id).authority, viewer, agent.pubkey)
  )
    return undefined;
  return async (signal) => {
    const result = await administerMember(
      {
        refresh: roles.refresh,
        snapshot: roles.snapshot,
        // An abandoned send publishes nothing it hasn't already.
        run: (id, change) => run(id, change, signal, () => !signal.aborted),
      },
      channel.id,
      agent.pubkey,
      (role) =>
        role === undefined
          ? { role: "member", expectedRole: "absent" }
          : role === "guest" || role === "unknown"
            ? // Authorization refuses an unknown role; it is never guessed.
              { role: "member", expectedRole: role }
            : // Any other role can already post here.
              undefined,
    );
    if (result.status !== "confirmed")
      throw new Error(
        result.status === "uncertain"
          ? unconfirmed
          : (result.error ?? "The change didn’t go through. Try again."),
      );
  };
}
