import type { Agents } from "./service";
import type { Host } from "../host/service";
import type { AttentionValue } from "./attention";

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
        const agent = agents
          .snapshot()
          .running.find((agent) => agent.pubkey === wake.agent);
        if (agent?.place !== "here" || !agent.attentionEnabled)
          throw new Error("Recipient Attention is not enabled");
        agents.wake(wake.agent, {
          channel: wake.channel,
          ...(wake.thread ? { root: wake.thread } : {}),
          text: wake.text,
        });
        await run(["archive-wake", item.file, item.signature]);
        continue;
      }
      const id = `monitor-${item.name}`;
      for (const pubkey of item.agents) {
        const agent = agents
          .snapshot()
          .running.find((agent) => agent.pubkey === pubkey);
        if (agent?.place !== "here")
          throw new Error("Recipient is not a local agent");
        const attention: Record<string, AttentionValue> = {};
        const interest = `interest/${id}`,
          watch = `watch/${id}`;
        const value: AttentionValue = {
          type: "source",
          provider: "buzz.agents/command",
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
        if (!agent.attention[interest])
          attention[interest] = {
            type: "interest",
            instructions: item.instructions,
          };
        if (!agent.attention[watch]) attention[watch] = value;
        if (Object.keys(attention).length)
          await agents.save(pubkey, { attention });
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
  let imported = "";
  let importing = false;
  let stopped = false;
  const migrate = () => {
    const snapshot = agents.snapshot();
    const recipients = JSON.stringify(
      snapshot.running.map((agent) => [
        agent.pubkey,
        agent.attentionEnabled,
        agents.relay(agent.pubkey)?.snapshot().status,
      ]),
    );
    if (
      stopped ||
      importing ||
      recipients === imported ||
      !snapshot.running.length
    )
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
  };
}
