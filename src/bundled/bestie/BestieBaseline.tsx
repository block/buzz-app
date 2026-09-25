import { useEffect, useState, useSyncExternalStore } from "react";
import type { MemorySnapshot } from "../../features/agents/memory";
import type { RelaySession } from "../../features/relay/session";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Select } from "../../shared/design-system/ui/Select";
import {
  parseBaseline,
  purposeTitles,
  recipeTitles,
  type Source,
} from "./baseline";

export function BestieBaseline({
  session,
  channelId,
  members,
}: {
  session: RelaySession;
  channelId: string;
  members: readonly string[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="compact" variant="ghost" onClick={() => setOpen(true)}>
        Journey
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Your Bestie journey"
        size="expanded"
        description="Onboarding, memory and background activity saved by your Bestie."
        closeLabel="Close journey"
      >
        {open && (
          <Journey session={session} channelId={channelId} members={members} />
        )}
      </Dialog>
    </>
  );
}

function Journey({
  session,
  channelId,
  members,
}: {
  session: RelaySession;
  channelId: string;
  members: readonly string[];
}) {
  const choices = useSyncExternalStore(
    session.agentChoices.subscribe,
    session.agentChoices.snapshot,
  );
  const [selected, setSelected] = useState("");
  useEffect(() => {
    const release = session.agentChoices.retain();
    session.agentChoices.ensure();
    return release;
  }, [session]);
  const agents = choices.identities.filter((agent) =>
    members.includes(agent.pubkey),
  );
  const agent = agents.find((item) => item.pubkey === selected);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Select
        label="Bestie identity"
        value={agent?.pubkey ?? ""}
        onValueChange={setSelected}
        placeholder="Choose your Bestie"
        groups={[
          {
            label: "Agents in this channel",
            options: agents.map((item) => ({
              value: item.pubkey,
              label: `${item.name || "Agent"} · ${item.pubkey.slice(0, 8)}`,
            })),
          },
        ]}
      />
      {!choices.complete && (
        <p role="status" className="text-body-sm text-muted">
          Agent choices may be incomplete.{" "}
          <Button
            size="compact"
            variant="ghost"
            onClick={() => void session.agentChoices.refresh()}
          >
            Refresh agents
          </Button>
        </p>
      )}
      {!agents.length && (
        <p className="text-body-sm">
          Create Bestie using Setup, then select it from mentions in this
          channel and send a greeting.
        </p>
      )}
      {agent && (
        <JourneyState
          key={agent.pubkey}
          session={session}
          channelId={channelId}
          pubkey={agent.pubkey}
          name={agent.name || "Bestie"}
        />
      )}
    </div>
  );
}

function Sources({ items }: { items: Source[] }) {
  return (
    <ul className="space-y-2 text-body-sm text-muted">
      {items.map((source) => (
        <li key={`${source.event}:${source.quote}`}>
          <q>{source.quote}</q>
          <div className="break-all font-mono text-mono">
            Message {source.event}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function JourneyState({
  session,
  channelId,
  pubkey,
  name,
}: {
  session: RelaySession;
  channelId: string;
  pubkey: string;
  name: string;
}) {
  const [current, setCurrent] = useState<{
    session: RelaySession;
    pubkey: string;
    snapshot: MemorySnapshot;
    refresh(): void;
  }>();
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let active = true;
    let view: ReturnType<RelaySession["agentMemories"]["open"]>;
    try {
      view = session.agentMemories.open(pubkey);
    } catch {
      setCurrent({
        session,
        pubkey,
        snapshot: { status: "unavailable" },
        refresh() {},
      });
      return;
    }
    const update = () => {
      if (active)
        setCurrent({
          session,
          pubkey,
          snapshot: view.snapshot(),
          refresh: () => void view.refresh(),
        });
    };
    const stop = view.subscribe(update);
    update();
    void view.refresh();
    return () => {
      active = false;
      stop();
      view.dispose();
    };
  }, [session, pubkey]);
  const snapshot =
    current?.session === session && current.pubkey === pubkey
      ? current.snapshot
      : undefined;
  const entry =
    snapshot?.status === "ready"
      ? snapshot.listing?.entries.find((item) => item.slug === "mem/bestie")
      : undefined;
  const state = entry ? parseBaseline(entry) : undefined;
  const matches =
    state?.owner === session.viewer && state?.channel === channelId;
  const request = (text: string) => {
    if (!matches || snapshot?.listing?.partial) return;
    try {
      session.messages.send(channelId, `@${name} ${text}`, [pubkey]);
      setNotice(
        "Request queued in the conversation. Wait for Bestie’s response, then refresh. No state change is confirmed yet.",
      );
    } catch {
      setNotice(
        "Could not queue the request. Check channel access and Outbox before retrying.",
      );
    }
  };
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Button size="compact" onClick={() => current?.refresh()}>
        Refresh journey
      </Button>
      {notice && (
        <p role="status" className="text-body-sm">
          {notice}
        </p>
      )}
      {!snapshot || snapshot.status === "loading" ? (
        <p role="status">Loading journey…</p>
      ) : snapshot.status !== "ready" ? (
        <p role="status">
          Journey memory is {snapshot.status}. Owner-view reads require the
          development broker and a connected community. Refresh after restoring
          access.
        </p>
      ) : !entry ? (
        <p>
          No baseline state in this snapshot. Use Setup to create a baseline
          Bestie and send it a greeting in a private channel.
        </p>
      ) : !state ? (
        <p role="alert">
          This memory is not a supported Bestie baseline. No controls are
          enabled.
        </p>
      ) : !matches ? (
        <p role="alert">
          This Bestie belongs to another owner or home channel. Open its home
          conversation to inspect the journey.
        </p>
      ) : (
        <>
          {snapshot.listing?.partial && (
            <p role="alert">
              Partial memory snapshot. Controls are paused until a complete read
              succeeds.
            </p>
          )}
          <p className="text-body-sm text-muted">
            Saved revision {state.revision} ·{" "}
            {new Date(entry.createdAt * 1000).toLocaleString()}
          </p>
          <section aria-label="Onboarding" className="space-y-3">
            <h3 className="text-heading">Try Bestie</h3>
            {Object.entries(recipeTitles).map(([id, title]) => {
              const recipe = state.recipes[id as keyof typeof recipeTitles];
              return (
                <div key={id} className="space-y-2">
                  <p className="text-body-sm">
                    {title} · {recipe.status}
                  </p>
                  {recipe.status !== "completed" && (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="compact"
                        disabled={!!snapshot.listing?.partial}
                        onClick={() =>
                          request(
                            `Let's start the ${id} onboarding recipe. Ask me for what you need.`,
                          )
                        }
                      >
                        Start {title.toLowerCase()}
                      </Button>
                      {recipe.status !== "skipped" && (
                        <Button
                          size="compact"
                          variant="ghost"
                          disabled={!!snapshot.listing?.partial}
                          onClick={() =>
                            request(
                              `Skip the ${id} onboarding recipe. Save that choice.`,
                            )
                          }
                        >
                          Skip
                        </Button>
                      )}
                    </div>
                  )}
                  {!!recipe.evidence.length && (
                    <details>
                      <summary className="text-body-sm">
                        Completion evidence
                      </summary>
                      <Sources items={recipe.evidence} />
                    </details>
                  )}
                </div>
              );
            })}
          </section>
          <section aria-label="Background operations" className="space-y-3">
            <h3 className="text-heading">Background operations</h3>
            <p className="text-body-sm text-muted">
              Automatic checks need the app and agent running. Requests take
              effect after Bestie saves them. Pausing reviews does not cancel
              scheduled reminders.
            </p>
            {Object.entries(purposeTitles).map(([id, title]) => {
              const cadence = state.cadences[id as keyof typeof purposeTitles];
              return (
                <div key={id} className="space-y-2">
                  <p className="text-body-sm">
                    {title} ·{" "}
                    {cadence.enabled
                      ? `every ${cadence.interval / 3600} hours, next ${new Date(cadence.nextDue * 1000).toLocaleString()}`
                      : "Paused"}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="compact"
                      disabled={!!snapshot.listing?.partial}
                      onClick={() =>
                        request(
                          `Run the ${id} operation now and save its result. Keep reflections private.`,
                        )
                      }
                    >
                      Run {title.toLowerCase()} now
                    </Button>
                    <Button
                      size="compact"
                      variant="ghost"
                      disabled={!!snapshot.listing?.partial}
                      onClick={() =>
                        request(
                          `${cadence.enabled ? "Pause" : "Enable"} the ${id} background cadence and save the setting.`,
                        )
                      }
                    >
                      {cadence.enabled ? "Pause" : "Enable"}{" "}
                      {title.toLowerCase()}
                    </Button>
                  </div>
                </div>
              );
            })}
          </section>
          <section aria-label="Memory tree" className="space-y-2">
            <h3 className="text-heading">Your remembered world</h3>
            <p className="text-body-sm text-muted">
              Owner-private records. Group records describe groups; they are not
              shared group memory.
            </p>
            {Object.entries(state.memory).map(([kind, rows]) => (
              <details key={kind} open>
                <summary className="text-body-sm">
                  {kind} ({Object.keys(rows).length})
                </summary>
                <div className="space-y-2 pl-4">
                  {Object.entries(rows).map(([id, row]) => (
                    <details key={id}>
                      <summary className="text-body-sm">{row.title}</summary>
                      <p className="whitespace-pre-wrap break-words text-body-sm">
                        {row.revisions.at(-1)?.text}
                      </p>
                      {!!row.links.length && (
                        <p className="text-body-sm text-muted">
                          Links: {row.links.join(", ")}
                        </p>
                      )}
                      {row.workflow && (
                        <p className="break-all text-body-sm">
                          Workflow: {row.workflow} (definition recorded; inspect
                          Workflows for execution)
                        </p>
                      )}
                      <Sources
                        items={row.revisions
                          .slice(-1)
                          .map((revision) => revision.source)}
                      />
                      {row.revisions.length > 1 && (
                        <details>
                          <summary className="text-body-sm">
                            Earlier versions
                          </summary>
                          {row.revisions.slice(0, -1).map((r) => (
                            <div key={`${r.at}:${r.source.event}:${r.text}`}>
                              <p className="whitespace-pre-wrap text-body-sm">
                                {r.text}
                              </p>
                              <Sources items={[r.source]} />
                            </div>
                          ))}
                        </details>
                      )}
                    </details>
                  ))}
                </div>
              </details>
            ))}
          </section>
          <section aria-label="Dreams" className="space-y-2">
            <h3 className="text-heading">Dreams</h3>
            {!state.dreams.length && (
              <p className="text-body-sm text-muted">
                No reflections yet. Add some memories, then run a dream.
              </p>
            )}
            {state.dreams.map((dream) => (
              <details key={`${dream.at}:${dream.summary}`}>
                <summary className="text-body-sm">
                  {new Date(dream.at * 1000).toLocaleString()} · Reflection, not
                  a fact
                </summary>
                <p className="whitespace-pre-wrap text-body-sm">
                  {dream.summary}
                </p>
                <Sources items={dream.sources} />
              </details>
            ))}
          </section>
          <details>
            <summary className="text-body-sm">Activity and evidence</summary>
            {state.runs
              .slice()
              .reverse()
              .map((run) => (
                <p
                  key={`${run.at}:${run.purpose}:${run.trigger}`}
                  className="text-body-sm"
                >
                  {new Date(run.at * 1000).toLocaleString()} · {run.purpose}:{" "}
                  {run.summary}
                </p>
              ))}
            {state.notes
              .slice()
              .reverse()
              .map((note) => (
                <p
                  key={`${note.event}:${note.changes.join(",")}`}
                  className="break-all text-body-sm"
                >
                  {new Date(note.at * 1000).toLocaleString()} ·{" "}
                  {note.changes.join(", ")} · Message {note.event}
                </p>
              ))}
          </details>
        </>
      )}
    </div>
  );
}
