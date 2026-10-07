import type { AgentDelivery } from "@buzz/author";
import { activity } from "./activity.ts";
import { parseConfig } from "./config.ts";
import { baseInstructions, rootOf, turnInput, sessionName } from "./prompt.ts";
import { AppServer, type Connect } from "./rpc.ts";
export const RUN_TIMEOUT_MS = 29 * 60_000;
type Delivery = AgentDelivery<unknown>;
function messageText(content: string, name: string) {
  // AI-authored messages may carry attribution before their mention/command.
  let text = content.trim().replace(/^🤖\s+/, "");
  const mention = `@${name}`;
  if (text.startsWith(mention)) text = text.slice(mention.length).trim();
  return text;
}
export function controlCommand(content: string, name: string) {
  const text = messageText(content, name);
  const command = /^\/(steer|stop|reset)(?:\s|$)/.exec(text)?.[1];
  return command === "reset"
    ? "stop"
    : (command as "steer" | "stop" | undefined);
}
type Stored = { threadId: string; signature: string };
export type Sessions = {
  get(key: string): Stored | undefined;
  set(key: string, value: Stored): void;
  delete(key: string): void;
};
type Active = {
  rpc: AppServer;
  threadId?: string;
  turnId?: string;
  ready: Promise<void>;
  steering: Promise<void>;
  reply: Delivery;
  stop: AbortController;
};
type Lane = { tail: Promise<void>; active?: Active; epoch: number };
const input = (text: string) => [{ type: "text", text, text_elements: [] }];
/** Per conversation serialization. Steering never starts a parallel Codex turn. */
export function createRunner(
  connect: Connect,
  sessions: Sessions,
  history: (
    delivery: Delivery,
    signal: AbortSignal,
  ) => Promise<string> = async () => "",
) {
  const lanes = new Map<string, Lane>();
  async function execute(
    delivery: Delivery,
    key: string,
    lane: Lane,
    content: string,
  ) {
    const config = parseConfig(delivery.config);
    if (!delivery.agent.workspace)
      throw new Error(
        "Choose a workspace in this agent's settings before running Codex.",
      );
    const rpc = new AppServer();
    const stop = new AbortController();
    const deadline = new AbortController();
    const timer = setTimeout(
      () =>
        deadline.abort(
          new DOMException(
            "Codex exceeded its 29-minute work limit",
            "TimeoutError",
          ),
        ),
      RUN_TIMEOUT_MS,
    );
    const signal = AbortSignal.any([
      delivery.signal,
      stop.signal,
      deadline.signal,
    ]);
    let ready!: () => void;
    let notReady!: (error: unknown) => void;
    const active: Active = {
      rpc,
      stop,
      steering: Promise.resolve(),
      reply: delivery,
      ready: new Promise<void>((resolve, reject) => {
        ready = resolve;
        notReady = reject;
      }),
    };
    void active.ready.catch(() => {});
    lane.active = active;
    const view = activity(delivery.live);
    const opening = delivery.live.step({
      kind: "tool",
      label: "Codex session",
    });
    let end!: (status: string) => void;
    let fail!: (error: Error) => void;
    const completed = new Promise<string>((resolve, reject) => {
      end = resolve;
      fail = reject;
    });
    void completed.catch(() => {});
    const off = rpc.onMessage((message) => {
      const { method } = message;
      const p = message.params as
        | {
            threadId: string;
            message: string;
            turn: { id: string; status: string; error?: { message: string } };
          }
        | undefined;
      if (method === "connection/closed") {
        fail(new Error(p?.message ?? "Codex connection closed"));
        return;
      }
      if (message.id != null && method) {
        // Never auto-approve an escalation or silently answer a model's question.
        void rpc
          .send({
            id: message.id,
            error: {
              code: -32601,
              message:
                "Buzz Codex runs with approvalPolicy=never; interactive requests are unsupported",
            },
          })
          .catch(fail);
        return;
      }
      if (!p || p.threadId !== active.threadId) return;
      if (method === "turn/started") active.turnId = p.turn.id;
      view.accept(message);
      if (method === "turn/completed") {
        if (p.turn.status === "failed")
          fail(new Error(p.turn.error?.message ?? "Codex turn failed"));
        else end(p.turn.status);
      }
    });
    let resuming = false;
    try {
      await rpc.open(connect, signal);
      signal.throwIfAborted();
      const signature = JSON.stringify([
        delivery.agent.pubkey,
        delivery.agent.workspace.path,
      ]);
      const saved = sessions.get(key);
      // A channel mention must not inherit the owner's credentialed MCP tools.
      // config/read normalizes absent options to null; TOML has no null value.
      const settings = await rpc.request<{
        config: { mcp_servers?: Record<string, Record<string, unknown>> };
      }>("config/read", { cwd: delivery.agent.workspace.path });
      const disabledMcp = Object.fromEntries(
        Object.entries(settings.config.mcp_servers ?? {}).map(
          ([name, server]) => [
            name,
            { ...withoutNulls(server), enabled: false },
          ],
        ),
      );
      const params = {
        ...(config.model ? { model: config.model } : {}),
        cwd: delivery.agent.workspace.path,
        baseInstructions: baseInstructions(delivery),
        approvalPolicy: "never",
        sandbox: "workspace-write",
        config: {
          "sandbox_workspace_write.network_access": false,
          mcp_servers: disabledMcp,
          "features.plugins": false,
          "features.apps": false,
        },
      };
      // Recovery is explicit: /reset forgets the binding without deleting Codex history.
      resuming = saved?.signature === signature;
      const started = await rpc.request<{ thread: { id: string } }>(
        saved?.signature === signature ? "thread/resume" : "thread/start",
        {
          ...params,
          ...(saved?.signature === signature
            ? { threadId: saved.threadId }
            : {}),
        },
      );
      resuming = false;
      active.threadId = started.thread.id;
      sessions.set(key, { threadId: started.thread.id, signature });
      await rpc.request("thread/name/set", {
        threadId: active.threadId,
        name: sessionName(delivery),
      });
      opening.finish();
      const turn = await rpc.request<{ turn: { id: string } }>("turn/start", {
        threadId: active.threadId,
        input: input(
          `${await history(delivery, signal)}${turnInput(delivery, content)}`,
        ),
        ...(config.model ? { model: config.model } : {}),
        ...(config.effort ? { effort: config.effort } : {}),
      });
      active.turnId = turn.turn.id;
      ready();
      const status = await completed;
      await active.steering;
      signal.throwIfAborted();
      if (status === "interrupted") {
        // Interrupt ends the turn, but Codex intentionally retains background
        // terminals. Stop promises to cancel those writes as well.
        const terminals = await rpc.request<{ data: { processId: string }[] }>(
          "thread/backgroundTerminals/list",
          { threadId: active.threadId, limit: 100 },
        );
        for (const terminal of terminals.data) {
          const result = await rpc.request<{ terminated: boolean }>(
            "thread/backgroundTerminals/terminate",
            { threadId: active.threadId, processId: terminal.processId },
          );
          if (!result.terminated) {
            const remaining = await rpc.request<typeof terminals>(
              "thread/backgroundTerminals/list",
              { threadId: active.threadId, limit: 100 },
            );
            if (remaining.data.some((p) => p.processId === terminal.processId))
              throw new Error("Codex background terminal could not be stopped");
          }
        }
        view.finish("Interrupted");
        await publish(
          active.reply,
          "Stopped Codex. Send another mention to continue this conversation.",
        );
      } else {
        const answer = view.final();
        if (answer?.text.trim()) {
          const published = await publish(active.reply, answer.text);
          answer.step.finish({ published: published.id });
        } else {
          await publish(
            active.reply,
            "Codex ended this turn without a final reply. Send another mention to ask it to continue or summarize its work.",
          );
        }
        view.finish();
      }
    } catch (error) {
      notReady(error);
      await active.steering;
      if (stop.signal.aborted) return;
      const failure = deadline.signal.aborted ? deadline.signal.reason : error;
      const message =
        failure instanceof Error ? failure.message : String(failure);
      opening.finish({ error: message });
      view.finish(message);
      if (
        !delivery.signal.aborted ||
        delivery.signal.reason?.name === "TimeoutError"
      )
        await publish(
          active.reply,
          `Codex could not finish: ${message}.${resuming ? " Use /reset to start a new conversation without deleting its Codex history." : ""}`,
        ).catch(() => {});
      throw error;
    } finally {
      clearTimeout(timer);
      off();
      rpc.close();
      if (lane.active === active) delete lane.active;
    }
  }
  const publish = (delivery: Delivery, content: string) => {
    if (!delivery.channelId) throw new Error("The mention has no channel");
    return delivery.agent.publish({
      kind: 9,
      content,
      tags: [
        ["h", delivery.channelId],
        ["e", rootOf(delivery.event), "", "reply"],
      ],
    });
  };
  return async (delivery: Delivery, scope: string) => {
    delivery.signal.throwIfAborted();
    if (!delivery.channelId) throw new Error("The mention has no channel");
    const key = JSON.stringify([
      scope,
      delivery.agent.id,
      delivery.channelId,
      delivery.conversation?.threadRootId ?? "channel",
    ]);
    const existing = lanes.get(key);
    let lane = existing;
    if (!lane) {
      lane = { tail: Promise.resolve(), epoch: 0 };
      lanes.set(key, lane);
    }
    let text = messageText(delivery.event.content, delivery.agent.name);
    const command = /^\/(steer|queue|stop|reset)(?:\s|$)/.exec(text)?.[1];
    if (command) text = text.replace(/^\/\w+\s*/, "");
    if (command === "reset") {
      if (delivery.event.pubkey !== delivery.agent.owner)
        throw new Error("Only the agent owner can reset Codex");
      if (lane.active) {
        await publish(
          delivery,
          "Codex is still working. Use /stop, then /reset once it has stopped.",
        );
        return;
      }
      lane.epoch++;
      delivery.cancelQueued();
      sessions.delete(key);
      if (!existing) lanes.delete(key);
      await publish(
        delivery,
        "Codex session reset. Your next mention starts a fresh session; the previous Codex history is retained.",
      );
      return;
    }
    if (command === "stop") {
      if (delivery.event.pubkey !== delivery.agent.owner)
        throw new Error("Only the agent owner can stop Codex");
      lane.epoch++;
      delivery.cancelQueued();
      const active = lane.active;
      if (active) {
        if (active.threadId && active.turnId)
          await active.rpc.request("turn/interrupt", {
            threadId: active.threadId,
            turnId: active.turnId,
          });
        else {
          active.stop.abort();
          await publish(
            delivery,
            "Stopped Codex during startup and cancelled queued work.",
          );
        }
      } else {
        await publish(
          delivery,
          "Codex is not running a turn in this conversation. Cancelled any queued work.",
        );
      }
      if (!existing) lanes.delete(key);
      return;
    }
    if (command === "steer" && !lane.active) {
      if (!existing) lanes.delete(key);
      await publish(
        delivery,
        "Codex is not running a turn in this conversation. Send a regular mention to start one.",
      );
      return;
    }
    if (command === "steer" && lane.active) {
      if (delivery.event.pubkey !== delivery.agent.owner)
        throw new Error("Only the agent owner can steer Codex");
      if (!text) throw new Error("Add a message after /steer");
      const active = lane.active;
      try {
        await active.ready;
        delivery.signal.throwIfAborted();
      } catch (error) {
        if (!delivery.signal.aborted)
          await publish(
            delivery,
            "Steering was not accepted because Codex could not start. Send a regular mention to try again.",
          );
        throw error;
      }
      // The server checks expectedTurnId; a late steering rejection is never replayed as a duplicate turn.
      const accepted = active.steering
        .then(() => history(delivery, delivery.signal))
        .then((context) =>
          active.rpc.request("turn/steer", {
            threadId: active.threadId,
            expectedTurnId: active.turnId,
            input: input(`${context}${turnInput(delivery, text, true)}`),
          }),
        )
        .then(
          () => {
            active.reply = delivery;
          },
          async (error) => {
            if (!delivery.signal.aborted)
              await publish(
                delivery,
                "Steering was not accepted; the turn may have finished. Send a regular mention to continue.",
              );
            throw error;
          },
        );
      // Completion can arrive before the steering acknowledgement. Publish only
      // after accepted steering has established the authoritative reply context.
      active.steering = accepted.catch(() => {});
      await accepted;
      delivery.live.step({ kind: "tool", label: "Steering accepted" }).finish();
      return;
    }
    const epoch = lane.epoch;
    const current = lane;
    const queued = current.active
      ? delivery.live.step({ kind: "tool", label: "Waiting for Codex" })
      : undefined;
    const job = current.tail
      .catch(() => {})
      .then(async () => {
        delivery.signal.throwIfAborted();
        if (epoch !== current.epoch) {
          queued?.finish({ error: "Queue cancelled" });
          return;
        }
        queued?.finish();
        await execute(delivery, key, current, text);
      });
    current.tail = job;
    try {
      await job;
    } finally {
      if (current.tail === job && !current.active) lanes.delete(key);
    }
  };
}

/** Keep literal server names (including dots) and valid transport definitions. */
function withoutNulls(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item != null)
      .map(([key, item]) => [
        key,
        typeof item === "object" && !Array.isArray(item)
          ? withoutNulls(item as Record<string, unknown>)
          : item,
      ]),
  );
}
