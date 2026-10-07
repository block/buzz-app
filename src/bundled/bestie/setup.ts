import type { Builderlab } from "../builderlab/service";
import type { RemoteAgent } from "../builderlab/agents/client";
import { oauthTarget } from "../builderlab/oauth/browser";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import { bestieInstructions, PROMPT_VERSION } from "./prompt";

type Record = {
  version: 1;
  owner: string;
  channelId: string;
  agent?: RemoteAgent;
  channelOperation?: string | undefined;
  channelFailed?: boolean | undefined;
  promptVersion?: string;
  welcomeId?: string | undefined;
  welcomeFailed?: boolean | undefined;
  complete?: boolean;
};
type State = Readonly<{
  status: "unavailable" | "idle" | "busy" | "choose-agent" | "ready" | "error";
  message: string;
  prerequisite?: "signin" | "community";
  candidates?: readonly RemoteAgent[];
  record?: Record | undefined;
  connection?: RelaySnapshot;
  community?: string;
}>;
const HEX = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function read(key: string, owner: string): Record | undefined {
  const raw = localStorage.getItem(key);
  if (!raw) return;
  let record: Record;
  try {
    record = JSON.parse(raw);
  } catch {
    throw new Error(
      "Saved Bestie setup is unreadable. No new agent was created.",
    );
  }
  if (
    record?.version !== 1 ||
    record.owner !== owner ||
    !HEX.test(owner) ||
    !UUID.test(record.channelId) ||
    (record.agent &&
      (typeof record.agent.id !== "string" ||
        !record.agent.id ||
        !HEX.test(record.agent.pubkey))) ||
    (record.complete && (!record.agent || !record.promptVersion)) ||
    [record.channelOperation, record.welcomeId].some(
      (id) => id !== undefined && !HEX.test(id),
    )
  )
    throw new Error(
      "Saved Bestie setup is invalid. Review it before retrying.",
    );
  return record;
}

/** Setup coordinates existing owners; it creates no connection or scheduler. */
export function createRemoteBestie(builderlab: Builderlab, relay: RelayData) {
  let disposed = false;
  let operation: AbortController | undefined;
  let work: Promise<void> | undefined;
  let state: State = {
    status: "unavailable",
    prerequisite: "signin",
    message: "Sign in to Builderlab to set up Bestie.",
  };
  const listeners = new Set<() => void>();
  const publish = (next: State) => {
    state = next;
    for (const listener of listeners) listener();
  };
  function scope() {
    if (builderlab.login.snapshot().status !== "signed-in") return;
    const enrollment = builderlab.enrollment.capture();
    if (!enrollment) return;
    return {
      enrollment,
      key: `buzz.remote-bestie.v1:${JSON.stringify([oauthTarget(), enrollment.credential.account.subject, enrollment.url, enrollment.viewer])}`,
    };
  }
  function refresh() {
    if (disposed) return;
    if (operation) operation.abort();
    try {
      const current = scope();
      if (!current) {
        const signedIn = builderlab.login.snapshot().status === "signed-in";
        publish({
          status: "unavailable",
          prerequisite: signedIn ? "community" : "signin",
          message: signedIn
            ? "Choose a community from the left sidebar for Bestie's private channel."
            : "Sign in to Builderlab to set up Bestie.",
        });
        return;
      }
      const record = read(current.key, current.enrollment.viewer);
      publish({
        status: record?.complete ? "ready" : "idle",
        message: record?.complete
          ? "Your remote Bestie is connected."
          : "Set up your remote Bestie in this community.",
        record,
        connection: current.enrollment.connection,
        community: current.enrollment.url,
      });
    } catch (error) {
      publish({
        status: "error",
        message:
          error instanceof Error
            ? error.message
            : "Bestie setup is unavailable.",
      });
    }
  }
  const stopRelay = relay.subscribe(refresh);
  const stopLogin = builderlab.login.subscribe(refresh);
  refresh();

  async function provision(signal: AbortSignal, selectedPubkey?: string) {
    const context = scope();
    if (!context)
      throw new Error(
        "Sign in to Builderlab and connect to a community first.",
      );
    const { key, enrollment } = context;
    const { viewer: owner, connection } = enrollment;
    const session = connection.session;
    const active = () =>
      !disposed && !signal.aborted && builderlab.enrollment.current(enrollment);
    const check = () => {
      signal.throwIfAborted();
      if (!active())
        throw new DOMException("Account or community changed.", "AbortError");
    };
    const progress = (message: string) => {
      check();
      publish({
        status: "busy",
        message,
        connection,
        community: enrollment.url,
      });
    };
    const saved = read(key, owner);
    const record: Record = saved ?? {
      version: 1,
      owner,
      channelId: crypto.randomUUID(),
    };
    const save = () => localStorage.setItem(key, JSON.stringify(record));
    const verifyHome = async () => {
      const home = await session.workSessions.refreshMembership(
        record.channelId,
      );
      check();
      if (
        home.channelType !== "stream" ||
        home.visibility !== "private" ||
        home.archived ||
        !home.members?.includes(owner) ||
        home.members.some(
          (member) => member !== owner && member !== record.agent?.pubkey,
        )
      )
        throw new Error(
          "Bestie's channel must be private and contain only you and Bestie. Review its members before continuing.",
        );
      return home;
    };
    save();
    progress("Finding your remote Bestie…");
    const rows = await builderlab.agents.list(signal);
    check();
    if (record.agent) {
      const agent = rows.find(
        (row) =>
          row.pubkey === record.agent?.pubkey && row.id === record.agent?.id,
      );
      if (!agent || !["Active", "Unattested"].includes(agent.status))
        throw new Error(
          "Your saved Bestie is unavailable. Review Remote agents in Builderlab settings.",
        );
      record.agent = agent;
    } else {
      const candidates = rows.filter(
        (row) =>
          row.name === "Bestie" &&
          ["Active", "Unattested"].includes(row.status),
      );
      if (
        selectedPubkey &&
        !candidates.some((row) => row.pubkey === selectedPubkey)
      )
        throw new Error("That Bestie is no longer available. Retry setup.");
      if (candidates.length > 1 && !selectedPubkey) {
        publish({
          status: "choose-agent",
          message:
            "You already have several Besties. Choose one to use for this channel.",
          candidates,
        });
        return;
      }
      record.agent =
        candidates.find((row) => row.pubkey === selectedPubkey) ??
        candidates[0] ??
        (await builderlab.agents.register("Bestie", signal));
      // Persist an allocation even when a canceled native request finished; retry
      // can recover it without allocating another agent.
      save();
      check();
    }
    progress("Connecting Bestie to this community…");
    builderlab.enrollment.remember(enrollment, record.agent);
    record.agent = await builderlab.agents.attest(
      record.agent,
      signal,
      active,
      owner,
    );
    check();
    save();
    await builderlab.enrollment.publish(
      enrollment,
      record.agent,
      signal,
      active,
    );
    check();

    progress("Opening your private Bestie channel…");
    const outbox = session.outbox;
    if (!outbox) throw new Error("This community cannot save Bestie setup.");
    await outbox.ready();
    check();
    async function recoverDismissed(
      field: "channelOperation" | "welcomeId",
      failed: "channelFailed" | "welcomeFailed",
    ) {
      const id = record[field];
      if (
        !id ||
        !record[failed] ||
        outbox?.snapshot().some((item) => item.event.id === id)
      )
        return;
      // Only a definitely failed, durably dismissed intent may be replaced.
      // Strong readback still protects an effect that reached the relay.
      const events = await session.read(
        [{ ids: [id], limit: 1, consistency: "strong" }],
        { fresh: true, signal },
      );
      check();
      if (!events.some((event) => event.id === id)) {
        record[field] = undefined;
        record[failed] = undefined;
        save();
      }
    }
    async function delivered(
      field: "channelOperation" | "welcomeId",
      failed: "channelFailed" | "welcomeFailed",
    ) {
      const id = record[field];
      if (!id) return;
      // A retry may reach the relay even when an earlier attempt was rejected.
      // Retire the old classification before starting a new delivery attempt.
      record[failed] = undefined;
      save();
      try {
        await session.workSessions.delivered(id, active);
      } catch (error) {
        record[failed] = session.workSessions.failed(id) || undefined;
        save();
        throw error;
      }
      check();
    }
    await session.channels.resolve?.([record.channelId], {
      fresh: true,
      signal,
    });
    check();
    const channel = () =>
      session.channels
        .list()
        .channels.find((row) => row.id === record?.channelId);
    if (!channel()) {
      await recoverDismissed("channelOperation", "channelFailed");
      record.channelOperation ??= outbox
        .snapshot()
        .find(
          (item) =>
            item.event.kind === 9007 &&
            item.event.tags.some(
              ([name, value]) => name === "h" && value === record?.channelId,
            ),
        )?.event.id;
      record.channelOperation ??= session.workSessions.createChannel(
        record.channelId,
        "Bestie",
        "private",
      );
      save();
      await delivered("channelOperation", "channelFailed");
      check();
      await session.workSessions.refresh(
        record.channelId,
        { member: owner },
        false,
      );
      check();
    }
    const home = await verifyHome();
    if (!home.members?.includes(record.agent.pubkey)) {
      progress("Inviting Bestie to the channel…");
      await session.memberAdditions.add(
        record.channelId,
        record.agent.pubkey,
        undefined,
        { startAgent: false },
      );
      check();
    }
    const confirmed = await verifyHome();
    if (!confirmed.members?.includes(record.agent.pubkey))
      throw new Error(
        "Bestie's invitation has not been confirmed. Retry setup.",
      );
    if (!record.promptVersion) {
      progress("Updating Bestie's instructions…");
      await builderlab.agents.updateInstructions(
        record.agent,
        bestieInstructions(owner, record.channelId),
        signal,
      );
      check();
      record.promptVersion = PROMPT_VERSION;
      save();
    }
    await recoverDismissed("welcomeId", "welcomeFailed");
    record.welcomeId ??= outbox
      .snapshot()
      .find(
        (item) => item.recovery?.key === `bestie-welcome:${record.channelId}`,
      )?.event.id;
    if (!record.welcomeId) {
      record.welcomeId = session.messages.send(
        record.channelId,
        "🤖 @Bestie Introduce yourself and help me get started with Buzz.",
        [record.agent.pubkey],
        [],
        {
          key: `bestie-welcome:${record.channelId}`,
          value: record.agent.pubkey,
        },
      );
      save();
    }
    if (record.welcomeId) {
      await delivered("welcomeId", "welcomeFailed");
      check();
    }
    record.complete = true;
    save();
    publish({
      status: "ready",
      message: "Your remote Bestie is connected.",
      record,
      connection,
      community: enrollment.url,
    });
  }
  function run(selectedPubkey?: string) {
    if (disposed) return Promise.resolve();
    if (work) return work;
    const controller = new AbortController();
    operation = controller;
    const task = async () => {
      const current = scope();
      if (!current)
        throw new Error(
          "Sign in to Builderlab and connect to a community first.",
        );
      if (typeof navigator !== "undefined" && navigator.locks)
        await navigator.locks.request(
          current.key,
          { signal: controller.signal },
          () => provision(controller.signal, selectedPubkey),
        );
      else await provision(controller.signal, selectedPubkey);
    };
    work = task()
      .catch((error) => {
        if (!disposed && !controller.signal.aborted) {
          const message =
            error instanceof Error
              ? error.message
              : "Bestie setup failed. Retry to continue.";
          publish({ ...state, status: "error", message });
        }
      })
      .finally(() => {
        if (operation === controller) operation = undefined;
        work = undefined;
      });
    return work;
  }
  return {
    login: builderlab.login,
    loginAvailable: builderlab.loginAvailable,
    loginUnavailableReason: builderlab.loginUnavailableReason,
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setup: (selectedPubkey?: string) => run(selectedPubkey),
    dispose() {
      disposed = true;
      operation?.abort();
      stopRelay();
      stopLogin();
      listeners.clear();
    },
  };
}
