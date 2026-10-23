import { useRef, useState } from "react";
import type { Agents } from "../agents/service";
import type { PortableAgent } from "../agents/native";
import type { MentionRecipient } from "./mention-draft";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Button } from "../../shared/design-system/ui/Button";
import { Select } from "../../shared/design-system/ui/Select";

type Pending = {
  found: readonly PortableAgent[];
  signal: AbortSignal;
  current(): boolean;
  finish(sent: boolean): void;
  busy: boolean;
  error?: string;
};

// Agents the owner chose to send to without importing; not asked again this run.
const declined = new Set<string>();

/** Offers to import a mentioned agent that only an earlier Buzz on this
 * machine runs, before the send that would otherwise go unanswered. */
export function useOldAgentMentions(
  agents: Agents | undefined,
  restoreFocus: () => void,
) {
  const [pending, setPending] = useState<Pending>();
  const [type, setType] = useState<string>();
  const importing = useRef(false);
  const importAction = useRef<HTMLButtonElement>(null);
  // Importing gives the agent a key here, so a hosted type cannot take one.
  const types = agents?.types().filter((item) => !item.remote) ?? [];
  const chosen = types.find((item) => item.key === type) ?? types[0];
  async function port() {
    if (!agents || !pending || !chosen || importing.current) return;
    importing.current = true;
    const request = pending;
    setPending({ ...request, busy: true });
    try {
      for (const agent of request.found) {
        request.signal.throwIfAborted();
        if (!request.current())
          throw new Error(
            "The draft changed. Close this dialog and send again.",
          );
        // A retry after a partial failure skips the ones that came over.
        if (agents.find(agent.pubkey)) continue;
        await agents.port({
          source: agent.source,
          pubkey: agent.pubkey,
          type: chosen.key,
        });
      }
      request.finish(true);
    } catch (reason) {
      if (!request.signal.aborted)
        setPending({
          ...request,
          busy: false,
          error: reason instanceof Error ? reason.message : String(reason),
        });
    } finally {
      importing.current = false;
    }
  }
  return {
    /** The mentioned agents an earlier Buzz on this machine still runs;
     * at once when none can be, so an ordinary send stays synchronous. */
    find(
      people: readonly MentionRecipient[],
    ): readonly PortableAgent[] | Promise<readonly PortableAgent[]> {
      if (!agents || !types.length) return [];
      // Agents already here, and ones the owner declined, are never offered.
      const here = new Set(
        agents.snapshot().agents.map((agent) => agent.pubkey),
      );
      const mentioned = new Set(
        people
          .map((person) => person.pubkey)
          .filter((key) => !declined.has(key) && !here.has(key)),
      );
      if (!mentioned.size) return [];
      // Only the desktop app can read earlier stores; elsewhere none are found.
      return agents.portable().then(
        (result) =>
          result.agents.filter((agent) => mentioned.has(agent.pubkey)),
        () => [],
      );
    },
    /** Resolves false when the owner closed the dialog and the send stops. */
    ask(
      found: readonly PortableAgent[],
      signal: AbortSignal,
      current: () => boolean,
    ) {
      signal.throwIfAborted();
      return new Promise<boolean>((resolve) => {
        const finish = (sent: boolean) => {
          signal.removeEventListener("abort", abort);
          setPending(undefined);
          resolve(sent);
        };
        const abort = () => finish(false);
        signal.addEventListener("abort", abort, { once: true });
        setPending({ found, signal, current, finish, busy: false });
      });
    },
    dialog: (
      <Dialog
        size="compact"
        open={!!pending}
        onOpenChange={(open) => {
          if (!open) pending?.finish(false);
        }}
        title={
          pending?.found.length === 1
            ? `Import ${pending.found[0]?.name}?`
            : "Import these agents?"
        }
        description={pending && describe(pending.found, !!chosen?.adopt)}
        preventClose={!!pending?.busy}
        initialFocus={importAction}
        finalFocus={() => {
          restoreFocus();
          return false;
        }}
        actions={
          <>
            <Button
              type="button"
              disabled={pending?.busy}
              onClick={() => {
                if (!pending) return;
                // A draft changed meanwhile is not sent, so nothing was declined.
                if (pending.current())
                  for (const agent of pending.found) declined.add(agent.pubkey);
                pending.finish(true);
              }}
            >
              Send without importing
            </Button>
            <Button
              ref={importAction}
              type="button"
              variant="prominent"
              disabled={pending?.busy || !chosen}
              onClick={() => void port()}
            >
              {pending?.busy ? "Importing…" : "Import and send"}
            </Button>
          </>
        }
      >
        {types.length > 1 && (
          <div className="flex">
            <Select
              label="Import as"
              value={chosen?.key ?? ""}
              disabled={!!pending?.busy}
              groups={[
                {
                  label: "Agent types",
                  options: types.map((item) => ({
                    value: item.key,
                    label: item.title,
                  })),
                },
              ]}
              onValueChange={setType}
            />
          </div>
        )}
        {pending?.error ? (
          <p role="alert">
            {pending.error} Your draft is kept. Agents already imported stay
            imported.
          </p>
        ) : null}
      </Dialog>
    ),
  };
}

function describe(found: readonly PortableAgent[], adopts: boolean) {
  const one = found.length === 1;
  const names = found.map((agent) => agent.name).join(", ");
  return `${names} ${one ? "is" : "are"} set up in a previous version of Buzz, so ${
    one ? "it answers" : "they answer"
  } only while that app runs. Import ${one ? "it" : "them"} to keep ${
    one ? "its" : "their"
  } ${adopts ? "key, name, picture and instructions" : "key, name and picture"} here. Quit the old app afterward, or both will answer.`;
}
