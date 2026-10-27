import type { Agents } from "./service";
import type { Host } from "../host/service";
import type { AttentionValue } from "./attention";
import type { RelayData } from "../relay/service";
import type { RelaySession } from "../relay/session";

type Registration = {
  file: string;
  signature: string;
  agents: string[];
  channel: string;
  root?: string;
  name: string;
  title: string;
  instructions: string;
  command: string[];
  cwd: string;
};
/** Archive only after every recipient has the saved Interest and source watch.
 * A failed or conflicting import remains on disk for the next startup. */
export async function importAttention(
  agents: Agents,
  host: Pick<Host, "spawn">,
) {
  const spawn = host.spawn?.bind(host);
  if (!spawn) return;
  const run = async (args: string[]) => {
    let output = "";
    const process = await spawn("attention-import", {
      args,
      onStdout: (data) => {
        output += data;
      },
      onStderr: (data) => console.warn("Attention migration:", data),
    });
    if ((await process.exited) !== 0)
      throw new Error("Attention migration failed");
    return output;
  };
  const recipient = (pubkey: string, channel: string) => {
    const memberships = agents
      .snapshot()
      .running.filter(
        (agent) => agent.pubkey === pubkey && agent.place === "here",
      );
    const [agent, ...others] = memberships.filter((agent) => {
      const relay = agents.relay(agent.key)?.snapshot();
      if (relay?.status !== "ready") return false;
      // Legacy state belongs to the bare-key home membership.
      if (memberships.length === 1 && agent.key === pubkey) return true;
      const channels = relay.session.channels;
      return (
        channels.list().channels.some(({ id }) => id === channel) ||
        Boolean(channels.get?.(channel))
      );
    });
    if (!agent || others.length)
      throw new Error(
        "Recipient destination membership is unavailable or ambiguous",
      );
    return agent;
  };
  const registrations: (
    | Registration
    | {
        file: string;
        signature: string;
        wake: { agent: string; channel: string; thread?: string; text: string };
      }
  )[] = JSON.parse(await run([]));
  for (const item of registrations) {
    try {
      if ("wake" in item) {
        const wake = item.wake;
        const agent = recipient(wake.agent, wake.channel);
        if (!agent.attentionEnabled)
          throw new Error("Recipient Attention is not enabled");
        agents.wake(agent.key, {
          channel: wake.channel,
          ...(wake.thread ? { root: wake.thread } : {}),
          text: wake.text,
        });
        await run(["archive-wake", item.file, item.signature]);
        continue;
      }
      const id = `monitor-${item.name}`;
      for (const pubkey of item.agents) {
        const agent = recipient(pubkey, item.channel);
        const attention: Record<string, AttentionValue> = {};
        const interest = `interest/${id}`,
          watch = `watch/${id}`;
        const value: AttentionValue = {
          type: "source",
          provider: "attention/command",
          interest_id: id,
          enabled: true,
          name: item.title,
          channel: item.channel,
          ...(item.root ? { root: item.root } : {}),
          config: { command: item.command, cwd: item.cwd },
        };
        if (
          agent.attention[watch] &&
          JSON.stringify(agent.attention[watch]?.value) !==
            JSON.stringify(value)
        )
          throw new Error("Watch id already has another registration");
        if (
          agent.attention[interest] &&
          (agent.attention[interest].value.type !== "interest" ||
            agent.attention[interest].value.instructions !== item.instructions)
        )
          throw new Error("Interest id already has another purpose");
        if (!agent.attention[interest])
          attention[interest] = {
            type: "interest",
            instructions: item.instructions,
          };
        if (!agent.attention[watch]) attention[watch] = value;
        if (Object.keys(attention).length)
          await agents.save(agent.key, { attention });
      }
      await run(["archive", item.file, item.signature]);
    } catch (error) {
      console.warn(
        `Attention kept legacy registration ${item.file} for recovery`,
        error,
      );
    }
  }
}

/** Retry retained files when local recipients or their connections become usable. */
export function watchAttentionImport(
  agents: Agents,
  host: Pick<Host, "spawn">,
) {
  if (!host.spawn) return () => {};
  const connections = new Map<
    RelayData,
    {
      session: RelaySession;
      stopRelay(): void;
      stopChannels(): void;
    }
  >();
  let imported = "";
  let importing = false;
  let stopped = false;
  const migrate = () => {
    if (stopped) return;
    const snapshot = agents.snapshot();
    const wanted = new Set<RelayData>();
    for (const agent of snapshot.running) {
      const relay = agents.relay(agent.key);
      if (!relay) continue;
      wanted.add(relay);
      const session = relay.snapshot().session;
      const current = connections.get(relay);
      if (!current)
        connections.set(relay, {
          session,
          stopRelay: relay.subscribe(migrate),
          stopChannels: session.channels.subscribeList(migrate),
        });
      else if (current.session !== session) {
        current.stopChannels();
        current.session = session;
        current.stopChannels = session.channels.subscribeList(migrate);
      }
    }
    for (const [relay, current] of connections)
      if (!wanted.has(relay)) {
        current.stopRelay();
        current.stopChannels();
        connections.delete(relay);
      }
    const recipients = JSON.stringify(
      snapshot.running.map((agent) => {
        const relay = agents.relay(agent.key)?.snapshot();
        return [
          agent.key,
          agent.attentionEnabled,
          relay?.status,
          relay?.generation,
          relay?.session.channels.list().channels.map(({ id }) => id),
        ];
      }),
    );
    if (importing || recipients === imported || !snapshot.running.length)
      return;
    imported = recipients;
    importing = true;
    void importAttention(agents, host)
      .catch((error) => console.warn("Attention migration failed", error))
      .finally(() => {
        importing = false;
        migrate();
      });
  };
  const unsubscribe = agents.subscribe(migrate);
  migrate();
  return () => {
    stopped = true;
    unsubscribe();
    for (const current of connections.values()) {
      current.stopRelay();
      current.stopChannels();
    }
    connections.clear();
  };
}
