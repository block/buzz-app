import {
  canStopAgent,
  type AgentControl,
  type AgentView,
} from "../../features/agents/control";
import { relayOrigin } from "../../features/communities/destination";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import { UUID } from "../../features/workflows/protocol";
import { viewRevision, writeView } from "../../shared/view-state";
import { agentDraft, agentEdit, newAgentDraft } from "../agents/agent-edit";
import { bestiePrompt } from "./prompt";

type Channel = {
  id: string;
  operation?: string | undefined;
  confirmed?: boolean;
};
export type BestieSetup = {
  version: 1;
  owner: string;
  origin: string;
  request: string;
  agent?: { id: string; pubkey: string; committed?: boolean };
  home: Channel;
  prompt?: string;
};
export type BestieState = {
  status: "waiting" | "setting-up" | "ready" | "error";
  message: string;
  connection?: RelaySnapshot;
  record?: BestieSetup;
};
const storageKey = "local-bestie";
const hex = /^[0-9a-f]{64}$/;
type Run = {
  connection: RelaySnapshot;
  abort: AbortController;
  task: Promise<void>;
  record?: BestieSetup;
  unwatch?: () => void;
};

/** Recovery uses exact IDs captured from this owner's create, never a display name. */
export function readSetup(
  scope: string,
  owner: string,
  origin: string,
): BestieSetup {
  const raw = viewRevision(scope, storageKey);
  if (raw === undefined)
    throw new Error("Bestie setup storage is unavailable.");
  if (raw === null)
    return {
      version: 1,
      owner,
      origin,
      request: crypto.randomUUID(),
      home: { id: crypto.randomUUID() },
    };
  const value = JSON.parse(raw) as BestieSetup;
  if (
    value.version !== 1 ||
    value.owner !== owner ||
    value.origin !== origin ||
    !UUID.test(value.request) ||
    !UUID.test(value.home?.id) ||
    (value.agent && (!value.agent.id || !hex.test(value.agent.pubkey)))
  )
    throw new Error(
      "Saved Bestie setup is invalid. Keep it for recovery; no replacement was created.",
    );
  return value;
}

export function privateHome(
  channel: ChannelSummary | undefined,
  record: BestieSetup,
) {
  return !!(
    channel &&
    !channel.cached &&
    !channel.archived &&
    channel.visibility === "private" &&
    channel.members?.includes(record.owner) &&
    channel.members.includes(record.agent?.pubkey ?? "") &&
    channel.members.every(
      (key) => key === record.owner || key === record.agent?.pubkey,
    )
  );
}

/** Plugin glue only: native controls and existing outbox/channel reads. */
export function createLocalBestie(relay: RelayData, control: AgentControl) {
  let state: BestieState = {
    status: "waiting",
    message: "Sign in to a community to meet your local Bestie.",
  };
  const listeners = new Set<() => void>();
  let closed = false;
  let current: Run | undefined;
  let retiring: Run | undefined;
  let barrier = Promise.resolve();
  const publish = (next: BestieState) => {
    if (closed) return;
    state = next;
    for (const listener of listeners) listener();
  };
  const persist = (connection: RelaySnapshot, record: BestieSetup) => {
    if (!connection.scope || !writeView(connection.scope, storageKey, record))
      throw new Error(
        "Couldn't save Bestie setup. No further resources were created.",
      );
  };
  const findAgent = (record: BestieSetup): AgentView | undefined => {
    const found = control
      .snapshot()
      .data?.agents.find((agent) => agent.id === record.agent?.id);
    if (
      found &&
      (found.pubkey !== record.agent?.pubkey ||
        relayOrigin(found.relayUrl) !== record.origin)
    )
      throw new Error("Bestie identity does not match its saved setup.");
    return found;
  };
  async function stopAgent(id: string) {
    const result = await control.action(id, "stop");
    const agent = result.agents.find((item) => item.id === id);
    if (!agent || agent.enabled || agent.status !== "stopped")
      throw new Error(
        "Bestie Stop is unconfirmed. Open Agents and stop Local Bestie before continuing.",
      );
  }

  async function stop(run: Run) {
    run.abort.abort();
    run.unwatch?.();
    const before = run.record && findAgent(run.record);
    if (before && canStopAgent(control.snapshot(), before.id))
      await stopAgent(before.id);
    // Creation may finish after cancellation; its exact ID is already persisted.
    await run.task.catch(() => {});
    const record = run.record;
    if (!record) return;
    const agent = findAgent(record);
    if (agent && (agent.enabled || agent.status !== "stopped"))
      await stopAgent(agent.id);
  }

  async function setup(run: Run) {
    const connection = run.connection;
    const session = connection.session;
    let audienceChecked = false;
    const check = () => {
      run.abort.signal.throwIfAborted();
      const now = relay.snapshot();
      if (
        closed ||
        now.session !== session ||
        now.viewer !== connection.viewer ||
        now.status !== "ready"
      )
        throw new Error("Community changed. Reopen Bestie after reconnecting.");
      if (
        audienceChecked &&
        !privateHome(
          session.channels
            .list()
            .channels.find((item) => item.id === record.home.id),
          record,
        )
      )
        throw new Error(
          "Bestie private membership is unavailable or changed. Restore its private audience and retry.",
        );
    };
    const save = () => {
      check();
      persist(connection, record);
    };
    if (!connection.scope || !connection.viewer)
      throw new Error("Sign in before setting up Bestie.");
    const origin = relayOrigin(
      connection.scope.slice(0, -(connection.viewer.length + 1)),
    );
    const record = readSetup(connection.scope, connection.viewer, origin);
    run.record = record;
    save(); // Reserve all stable IDs before any side effect.
    const progress = (message: string) => {
      check();
      publish({ status: "setting-up", message, connection, record });
    };
    await control.refresh();
    check();
    const local = control.snapshot();
    if (local.status !== "ready")
      throw new Error(
        local.error ?? "Could not check local agents. Retry setup.",
      );
    if (!local.data?.runtimeAvailable)
      throw new Error(
        local.data?.runtimeMessage ??
          "Local Bestie needs the desktop agent runtime. Open Agents to check setup.",
      );
    if (!local.data.createAvailable || !control.create)
      throw new Error(
        "Local agent creation is unavailable. Open Agents to check setup.",
      );
    if (local.busy)
      throw new Error(
        "Another agent change is in progress. Retry Bestie when it finishes.",
      );
    let agent = findAgent(record);
    if (!agent) {
      if (record.agent?.committed)
        throw new Error(
          "The saved local Bestie is missing. Restore it in Agents; no replacement was created.",
        );
      progress("Creating your local Bestie…");
      const draft = newAgentDraft(local);
      agent = await control.create(
        record.request,
        origin,
        record.owner,
        agentEdit({
          ...draft,
          name: "Local Bestie",
          systemPrompt:
            "You are the owner's local Bestie. Setup is not finished; do not start work yet.",
          environment: {
            BUZZ_ACP_AGENTS: "1",
            BUZZ_ACP_CHANNELS: record.home.id,
          },
        }),
        (prepared) => {
          check();
          record.agent = { ...prepared };
          save();
        },
      );
      check();
    }
    record.agent = { id: agent.id, pubkey: agent.pubkey, committed: true };
    save();
    if (canStopAgent(control.snapshot(), agent.id)) {
      await stopAgent(agent.id);
      check();
      agent = findAgent(record);
      if (!agent) throw new Error("Bestie is missing from local Agents.");
    }
    if (agent.startOnAppLaunch) {
      if (!control.setStartOnAppLaunch)
        throw new Error(
          "Update the desktop app before continuing Bestie setup.",
        );
      await control.setStartOnAppLaunch(agent.id, false);
      check();
    }
    if (agent.profilePending !== false) {
      progress("Publishing Bestie's profile…");
      if (!control.publishProfile)
        throw new Error(
          "Profile publication is unavailable in this desktop app.",
        );
      await control.publishProfile(agent.id);
      check();
    }
    session.profiles.ensure([agent.pubkey]);
    session.channels.ensureList();
    await session.outbox?.ready();
    check();
    const home = record.home;
    progress("Preparing Bestie…");
    if (!home.confirmed) {
      home.operation ??= session.outbox
        ?.snapshot()
        .find(
          (item) =>
            item.event.kind === 9007 &&
            item.event.tags.some(
              ([key, value]) => key === "h" && value === home.id,
            ),
        )?.event.id;
      if (!home.operation) {
        home.operation = session.workSessions.create(home.id, "Bestie");
        save();
      }
      await session.workSessions.delivered(
        home.operation,
        () => !run.abort.signal.aborted,
      );
      check();
      await session.workSessions.refresh(
        home.id,
        { member: record.owner },
        true,
      );
      check();
      await session.workSessions.addAgents(
        home.id,
        [agent.pubkey],
        () => !run.abort.signal.aborted,
      );
      check();
      home.confirmed = true;
      save();
    }
    await session.workSessions.refresh(
      home.id,
      { members: [record.owner, agent.pubkey] },
      true,
    );
    check();
    const summary = session.channels
      .list()
      .channels.find((item) => item.id === home.id);
    if (!privateHome(summary, record) || summary?.channelType !== "session")
      throw new Error(
        "Bestie's private channel membership changed. Restore the owner/Bestie audience before retrying.",
      );
    audienceChecked = true;
    check();
    run.unwatch = session.channels.subscribeList(() => {
      if (run.abort.signal.aborted) return;
      const channels = session.channels.list();
      if (channels.status !== "ready") return;
      if (
        privateHome(
          channels.channels.find((item) => item.id === record.home.id),
          record,
        )
      )
        return;
      run.abort.abort();
      publish({
        status: "error",
        message:
          "Bestie's private audience changed. Stopping its local runner; restore its private chat and retry.",
        connection,
        record,
      });
      if (record.agent)
        void stopAgent(record.agent.id).catch(() => {
          if (current !== run) return;
          publish({
            status: "error",
            message:
              "Bestie's audience changed and Stop is unconfirmed. Open Agents and stop Local Bestie before continuing.",
            connection,
            record,
          });
        });
    });
    agent = findAgent(record);
    if (!agent) throw new Error("Bestie is missing from local Agents.");
    const prompt = bestiePrompt({
      owner: record.owner,
      agentPubkey: agent.pubkey,
      home: record.home.id,
    });
    progress("Installing Bestie's instructions…");
    await control.save(
      agent.id,
      agent.revision,
      agentEdit({
        ...agentDraft(agent),
        systemPrompt:
          !record.prompt || agent.systemPrompt === record.prompt
            ? prompt
            : agent.systemPrompt,
        environment: {
          BUZZ_ACP_AGENTS: "1",
          BUZZ_ACP_CHANNELS: record.home.id,
        },
      }),
    );
    check();
    record.prompt = prompt;
    save();
    progress("Starting your local Bestie…");
    const latest = findAgent(record);
    if (!latest) throw new Error("Bestie is missing from local Agents.");
    const result =
      latest.status === "running"
        ? control.snapshot().data
        : await control.action(latest.id, "start");
    check();
    if (
      result?.agents.find((item) => item.id === latest.id)?.status !== "running"
    )
      throw new Error(
        "Bestie is saved but couldn't start. Configure inference in Settings → Agents, then retry.",
      );
    publish({
      status: "ready",
      message:
        "Local Bestie is set up. It runs while this desktop and Buzz are awake.",
      connection,
      record,
    });
  }

  function connect(force = false) {
    if (closed) return;
    const connection = relay.snapshot();
    if (
      !force &&
      current?.connection.session === connection.session &&
      connection.status === "ready" &&
      !current.abort.signal.aborted
    )
      return;
    if (current) {
      const previous = current;
      previous.abort.abort();
      previous.unwatch?.();
      barrier = barrier
        .catch(() => {})
        .then(async () => {
          // A failed Stop remains bound to its exact old community/identity even
          // if a later community has not yet allocated any resources.
          if (retiring && retiring !== previous) await stop(retiring);
          retiring = previous;
          await stop(previous);
          retiring = undefined;
        });
      current = undefined;
    }
    if (
      connection.status !== "ready" ||
      connection.cached ||
      !connection.viewer ||
      !connection.scope
    ) {
      publish({
        status: "waiting",
        message: "Sign in to a community to meet your local Bestie.",
      });
      return;
    }
    const run: Run = {
      connection,
      abort: new AbortController(),
      task: Promise.resolve(),
    };
    current = run;
    publish({
      status: "setting-up",
      message: "Checking local Bestie setup…",
      connection,
    });
    run.task = barrier
      .then(() => setup(run))
      .catch(async (error: unknown) => {
        if (run.abort.signal.aborted || closed) return;
        let problem = error;
        if (run.record) {
          const failed = findAgent(run.record);
          if (failed && (failed.enabled || failed.status !== "stopped"))
            await stopAgent(failed.id).catch((stopError: unknown) => {
              problem = stopError;
            });
        }
        if (run.abort.signal.aborted || closed || current !== run) return;
        publish({
          status: "error",
          message:
            problem instanceof Error
              ? problem.message
              : "Bestie setup couldn't finish. Retry after checking Agents.",
          connection,
          ...(run.record ? { record: run.record } : {}),
        });
      });
  }
  const unsubscribe = relay.subscribe(() => connect());
  connect();
  return {
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    retry: () => connect(true),
    async dispose() {
      closed = true;
      unsubscribe();
      listeners.clear();
      current?.abort.abort();
      await barrier.catch(() => {});
      if (retiring) await stop(retiring);
      if (current) {
        current.abort.abort();
        await stop(current);
      }
    },
  };
}
