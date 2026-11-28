// Owner actions on an agent that every surface showing it offers: the
// Agents Build view and the profile panel.
import { useRef, useState, type ReactNode } from "react";
import { TrashIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import type { Agent, Agents } from "./service";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const hostOf = (origin: string) => origin.replace(/^https:\/\//, "");

/** Whether the agent shown here is also in another of the owner's
 * communities that it isn't leaving, so it can be removed from this one
 * alone, or again after a Remove that didn't finish. */
export const inSeveral = (agents: Agents, agent: Agent) =>
  agent.place === "here" &&
  agents
    .memberships(agent.pubkey)
    .some((membership) => membership.key !== agent.key && !membership.deleting);

/** One field list for every surface explaining shared settings. */
export const sharedAgentSettings =
  "Name, type and settings, including instructions, model and workspace, are shared across communities.";

/** What adding the same agent to another community shares and what it keeps
 * there, as every place that adds one says it. */
export const sameAgent = (many = false) =>
  many
    ? `${sharedAgentSettings} A change to them applies in every community. Their pictures and what they pay attention to are their own in each. Memory is kept per community, so anything they saved here before comes back, and so do their conversations here.`
    : `${sharedAgentSettings} A change to them applies in every community. Its picture and what it pays attention to are its own in each. Memory is kept per community, so anything it saved here before comes back, and so do its conversations here.`;

/** Delete, after a confirmation that says what it does. Confirming closes the
 * dialog immediately so the UI stays responsive while cleanup runs; if it
 * fails, the error surfaces inline and in the dialog, where any unreachable
 * community can be given up on. */
export function AgentDelete({
  agents,
  agent,
  onRemoved,
  trigger,
}: {
  agents: Agents;
  agent: Agent;
  onRemoved(): void;
  trigger?: (open: () => void) => ReactNode;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const [confirming, setConfirming] = useState(false);
  const [localRemoving, setLocalRemoving] = useState(false);
  const [forgetting, setForgetting] = useState(false);
  const [error, setError] = useState("");
  // Forgot where it couldn't reach, so Delete is what is left to press.
  const [forgot, setForgot] = useState(false);
  const removing = Boolean(agent.removing) || localRemoving;
  const visibleError = removing ? "" : error || agent.removeError || "";
  const memberships =
    agent.place === "here" ? agents.memberships(agent.pubkey) : [];
  const several = memberships.length > 1;
  // Only a Delete that started can be given up on where it can't reach.
  const unreachable = memberships.filter(
    (membership) => membership.deleting && !membership.connected,
  );
  const remove = () => {
    setError("");
    setForgot(false);
    setConfirming(false);
    setLocalRemoving(true);
    void Promise.resolve(agents.remove(agent.key)).then(
      () => {
        setLocalRemoving(false);
        onRemoved();
      },
      (reason) => {
        setLocalRemoving(false);
        setError(message(reason));
      },
    );
  };
  const forget = async (key: string) => {
    setForgetting(true);
    setError("");
    try {
      await agents.forget(key);
      if (agents.memberships(agent.pubkey).length) {
        setForgot(true);
        setForgetting(false);
      } else {
        setConfirming(false);
        setForgetting(false);
        onRemoved();
      }
    } catch (reason) {
      setError(message(reason));
      setForgetting(false);
    }
  };
  return (
    <>
      {trigger ? (
        trigger(() => setConfirming(true))
      ) : (
        <div className="flex flex-col items-start gap-2">
          <Button
            size="compact"
            variant="ghost"
            loading={removing}
            disabled={removing}
            onClick={() => setConfirming(true)}
          >
            <TrashIcon size={14} aria-hidden="true" />{" "}
            {removing ? "Deleting…" : "Delete agent"}
          </Button>
          {visibleError ? (
            <p role="alert" className="m-0 text-body-sm text-danger">
              {visibleError}
            </p>
          ) : null}
        </div>
      )}
      <Dialog
        size="compact"
        open={confirming}
        initialFocus={cancel}
        onOpenChange={setConfirming}
        title={`Delete ${agent.name}?`}
        description={
          agent.place === "hosted"
            ? "Its provider deletes it and its key, then it leaves every channel and is archived so it no longer appears in member lists or mention suggestions. It can't be undone."
            : several
              ? "It stops in every community it's in. In each one it leaves every channel and is archived so it no longer appears in member lists or mention suggestions, then its key is deleted from this device. It can't be undone."
              : "It stops, leaves every channel and is archived so it no longer appears in member lists or mention suggestions, then its key is deleted from this device. It can't be undone."
        }
        preventClose={forgetting}
        actions={
          <>
            <Button
              ref={cancel}
              onClick={() => setConfirming(false)}
              disabled={forgetting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={forgetting || removing}
              onClick={remove}
            >
              Delete
            </Button>
          </>
        }
      >
        {several || visibleError || unreachable.length || forgot ? (
          <div className="flex flex-col gap-3">
            {several && (
              <ul
                aria-label="Its communities"
                className="m-0 flex list-none flex-col gap-1 p-0"
              >
                {memberships.map((membership) => (
                  <li
                    key={membership.key}
                    className="flex items-center justify-between gap-2 text-body-sm"
                  >
                    <span className="truncate">
                      {hostOf(membership.origin)}
                      {!membership.connected && (
                        <span className="text-secondary"> · Not connected</span>
                      )}
                    </span>
                    {unreachable.includes(membership) && (
                      <Button
                        size="compact"
                        variant="outline"
                        aria-label={`Forget it in ${hostOf(membership.origin)}`}
                        disabled={forgetting}
                        onClick={() => void forget(membership.key)}
                      >
                        Forget
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {visibleError ? (
              <p role="alert" className="m-0 text-body-sm text-danger">
                {visibleError}
              </p>
            ) : null}
            {unreachable.length > 0 && (
              <p className="m-0 text-body-sm text-secondary">
                Forget deletes it from this device without reaching that
                community, so it may stay in its channels there.
              </p>
            )}
            {forgot &&
              !unreachable.length &&
              // A Delete marks every membership; a Remove only its own.
              memberships.every((membership) => membership.deleting) && (
                <p className="m-0 text-body-sm text-secondary">
                  Delete again to finish here.
                </p>
              )}
            {!several && unreachable[0] && (
              <div>
                <Button
                  size="compact"
                  // Its last key goes with it.
                  variant="destructive"
                  disabled={forgetting}
                  onClick={() => void forget(unreachable[0]?.key ?? "")}
                >
                  Forget it
                </Button>
              </div>
            )}
          </div>
        ) : null}
      </Dialog>
    </>
  );
}

/** Takes the agent out of the community shown, after a confirmation, and
 * keeps it in its others. Offer it only while it is in another: see
 * `inSeveral`. */
export function AgentRemoveHere({
  agents,
  agent,
  onRemoved,
  trigger,
}: {
  agents: Agents;
  agent: Agent;
  onRemoved(): void;
  trigger: (open: () => void) => ReactNode;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const [confirming, setConfirming] = useState(false);
  const [localRemoving, setLocalRemoving] = useState(false);
  const [error, setError] = useState("");
  const removing = Boolean(agent.removing) || localRemoving;
  const visibleError = removing ? "" : error || agent.removeError || "";
  const place = agent.relay.replace(/^wss:\/\//, "");
  const leave = () => {
    setError("");
    setConfirming(false);
    setLocalRemoving(true);
    void Promise.resolve(agents.leave(agent.key)).then(
      () => {
        setLocalRemoving(false);
        onRemoved();
      },
      (reason) => {
        setLocalRemoving(false);
        setError(message(reason));
      },
    );
  };
  return (
    <>
      {trigger(() => setConfirming(true))}
      <Dialog
        size="compact"
        open={confirming}
        initialFocus={cancel}
        onOpenChange={setConfirming}
        title={`Remove ${agent.name} from ${place}?`}
        description="It stops here, leaves this community's channels and is archived here. It stays in your other communities with the same name, type and settings. Add it here again and its memory and conversations here come back, but what it paid attention to here doesn't."
        actions={
          <>
            <Button ref={cancel} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={removing} onClick={leave}>
              Remove
            </Button>
          </>
        }
      >
        {visibleError ? (
          <p role="alert" className="m-0 text-body-sm text-danger">
            {visibleError}
          </p>
        ) : null}
      </Dialog>
    </>
  );
}

/** Checks again, for an imported agent, that it is not archived in its
 * community, which import could not confirm. */
export function AgentArchiveRetry({
  agents,
  agent,
}: {
  agents: Pick<Agents, "unarchive">;
  agent: Agent;
}) {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState("");
  if (!agent.archiveUnchecked && !result) return null;
  const retry = async () => {
    setChecking(true);
    setResult("");
    try {
      setResult((await agents.unarchive(agent.key)) ?? "");
    } catch (reason) {
      setResult(`Couldn't check whether it's archived: ${message(reason)}`);
    } finally {
      setChecking(false);
    }
  };
  return (
    <PreferenceRow
      title="Archive state"
      subtitle={
        result ||
        "Not checked since import, so it may be hidden from member lists and mentions."
      }
      trailing={
        agent.archiveUnchecked ? (
          <Button
            size="compact"
            loading={checking}
            onClick={() => void retry()}
          >
            Retry
          </Button>
        ) : undefined
      }
    />
  );
}
