import type {
  Agent,
  AgentHandle,
  Delivery,
} from "../../features/agents2/service";
import type { RelayData } from "../../features/relay/service";
import type { EventData } from "../../features/relay/events";
import { config, absoluteWorkspace, type Config } from "./config";
import { conversationHistory } from "./history";
import {
  developerInstructions,
  rootOf,
  sessionName,
  turnInput,
  type Conversation,
} from "./prompt";
import { AppServer, listModels, type Spawn } from "./rpc";

type Request = {
  event: EventData;
  agent: AgentHandle;
  settings: Config;
  conversation: Conversation;
  interest: string;
};
type Saved = { threadId: string; workspace: string };
type Active = {
  threadId?: string;
  turnId?: string;
  ready: Promise<void>;
  steering: Promise<void>;
  reply: Request;
  finished: boolean;
};
type Lane = {
  tail: Promise<void>;
  active?: Active;
};
type Entry = {
  storageKey: string;
  abort: AbortController;
  rpc: AppServer;
  opening: Promise<AppServer>;
  lanes: Map<string, Lane>;
  saved: Record<string, Saved>;
};
export type SessionView = { key: string; status: string; detail: string };
const input = (text: string) => [{ type: "text", text, text_elements: [] }];
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
function textOf(event: EventData, name: string) {
  let text = event.content.trim().replace(/^🤖\s+/, "");
  if (text.startsWith(`@${name}`)) text = text.slice(name.length + 1).trim();
  return text;
}

/** Agents2 owns admission/identity. This plugin owns work after hand-over, and
 * uses one app-server per agent with independent Codex threads per conversation. */
export class CodexRuntime {
  private entries = new Map<string, Entry>();
  private views = new Map<string, readonly SessionView[]>();
  private listeners = new Set<() => void>();
  private scope = "";
  constructor(
    private readonly spawn: Spawn,
    private readonly relay: RelayData,
    private readonly storage: Storage = localStorage,
  ) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  sessions = (pubkey: string): readonly SessionView[] =>
    this.views.get(pubkey) ?? EMPTY;
  private status(pubkey: string, key: string, status: string, detail = "") {
    const others = this.sessions(pubkey).filter((view) => view.key !== key);
    this.views.set(pubkey, [
      ...others.slice(-31),
      { key, status, detail: detail.slice(0, 4000) },
    ]);
    for (const listener of this.listeners) listener();
  }
  sync(agents: readonly Agent[], scope: string) {
    if (scope !== this.scope) {
      this.dispose();
      this.scope = scope;
    }
    const present = new Set(agents.map((agent) => agent.pubkey));
    for (const [pubkey, entry] of this.entries)
      if (!present.has(pubkey)) {
        entry.abort.abort();
        void entry.rpc.close();
        this.entries.delete(pubkey);
        this.views.delete(pubkey);
      }
    for (const listener of this.listeners) listener();
  }
  dispose() {
    for (const entry of this.entries.values()) {
      entry.abort.abort();
      void entry.rpc.close();
    }
    this.entries.clear();
    this.views.clear();
  }
  private entry(request: Request) {
    const pubkey = request.agent.pubkey;
    const prior = this.entries.get(pubkey);
    if (prior) return prior;
    let saved: Record<string, Saved> = {};
    try {
      const stored: unknown = JSON.parse(
        this.storage.getItem(this.storageKey(pubkey)) ?? "{}",
      );
      if (stored && typeof stored === "object" && !Array.isArray(stored))
        saved = Object.fromEntries(
          Object.entries(stored).filter(
            ([, value]) =>
              value &&
              typeof value.threadId === "string" &&
              typeof value.workspace === "string",
          ),
        );
    } catch {
      /* Start fresh after malformed local data. */
    }
    const rpc = new AppServer();
    const entry: Entry = {
      storageKey: this.storageKey(pubkey),
      abort: new AbortController(),
      rpc,
      saved,
      lanes: new Map(),
      opening: rpc.open(this.spawn, request.settings.workspace),
    };
    // An exit fails current work and permits the next ordinary mention to reopen.
    rpc.onMessage((wire) => {
      if (
        wire.method === "connection/closed" &&
        this.entries.get(pubkey) === entry
      ) {
        this.entries.delete(pubkey);
      }
    });
    void entry.opening.catch(() => {
      if (this.entries.get(pubkey) === entry) this.entries.delete(pubkey);
      void rpc.close();
    });
    this.entries.set(pubkey, entry);
    return entry;
  }
  private storageKey(pubkey: string) {
    return `buzz.codex.sessions.v2:${this.scope}:${pubkey}`;
  }
  private save(request: Request, entry: Entry, key: string, saved: Saved) {
    entry.saved[key] = saved;
    // Retain a bounded set of bindings; this never deletes Codex's own history.
    entry.saved = Object.fromEntries(Object.entries(entry.saved).slice(-200));
    try {
      this.storage.setItem(entry.storageKey, JSON.stringify(entry.saved));
    } catch (error) {
      this.status(
        request.agent.pubkey,
        key,
        "Session could not be saved",
        message(error),
      );
    }
  }
  async run(delivery: Delivery) {
    delivery.signal.throwIfAborted();
    const { trigger, agent } = delivery;
    if (trigger.type === "timer")
      throw new Error(
        "Codex timers are not supported yet; use mentions or event watches.",
      );
    if (trigger.event.pubkey !== agent.owner) return;
    const snapshot = this.relay.snapshot();
    if (snapshot.status !== "ready")
      throw new Error("Connect to the agent's community first");
    const channelId = delivery.channelId;
    if (!channelId) throw new Error("The event has no unambiguous channel");
    const settings = config(delivery.config);
    const channel = snapshot.session.channels
      .list()
      .channels.find((row) => row.id === channelId);
    const root =
      channel?.channelType === "dm" || settings.scope === "channel"
        ? undefined
        : rootOf(trigger.event);
    const request: Request = {
      event: trigger.event,
      agent,
      settings,
      conversation: {
        channelId,
        name: channel?.name ?? channelId,
        ...(root ? { root } : {}),
      },
      interest:
        trigger.type === "watch" ? (trigger.interest?.instructions ?? "") : "",
    };
    if (!absoluteWorkspace(settings.workspace)) {
      await this.publish(
        request,
        "Choose an absolute workspace path in Codex settings first.",
      );
      return;
    }
    const key = JSON.stringify([channelId, root ?? "channel"]);
    const text = textOf(request.event, agent.name);
    const entry = this.entry(request);
    let lane = entry.lanes.get(key);
    if (!lane) {
      lane = { tail: Promise.resolve() };
      entry.lanes.set(key, lane);
    }
    if (lane.active) {
      const active = lane.active;
      // Startup and history reads stay ordered without holding Agents2 delivery.
      const accepted = active.steering.then(async () => {
        try {
          await active.ready;
          if (entry.abort.signal.aborted) return;
          if (active.finished) {
            this.start(request, text, key, lane, entry);
            return;
          }
          const context = await this.history(request, entry.abort.signal);
          if (entry.abort.signal.aborted) return;
          if (active.finished) {
            this.start(request, text, key, lane, entry);
            return;
          }
          await entry.rpc.request("turn/steer", {
            threadId: active.threadId,
            expectedTurnId: active.turnId,
            input: input(
              `${context}${turnInput(request.event, request.conversation, text, request.interest, true)}`,
            ),
          });
          active.reply = request;
        } catch (error) {
          if (entry.abort.signal.aborted) return;
          // A completion racing the request means this is the next ordinary turn.
          if (message(error) === "no active turn to steer") {
            this.start(request, text, key, lane, entry);
            return;
          }
          await this.publish(
            request,
            `Steering was not accepted: ${message(error)}. Send another mention to continue.`,
          );
        }
      });
      active.steering = accepted.catch((error) =>
        console.error("Codex steering failed", error),
      );
      return;
    }
    this.start(request, text, key, lane, entry);
  }
  private start(
    request: Request,
    text: string,
    key: string,
    lane: Lane,
    entry: Entry,
  ) {
    const current = lane;
    const job = lane.tail
      .catch(() => undefined)
      .then(async () => {
        if (entry.abort.signal.aborted) return;
        await this.execute(request, text, key, current, entry);
      });
    lane.tail = job;
    this.status(request.agent.pubkey, key, "Starting");
    // Agents2 can deliver follow-ups and other conversations immediately.
    void job
      .catch((error) => console.error("Codex turn failed", error))
      .finally(() => {
        if (current.tail === job && !current.active) entry.lanes.delete(key);
      });
  }
  private async history(request: Request, signal: AbortSignal) {
    signal.throwIfAborted();
    const snapshot = this.relay.snapshot();
    if (snapshot.status !== "ready" || snapshot.scope !== this.scope)
      throw new Error("The community changed");
    return conversationHistory(request.event, request.conversation, (filters) =>
      snapshot.session.read(filters, { signal }),
    );
  }
  private publish(request: Request, content: string) {
    const root = rootOf(request.event);
    return request.agent.publish({
      kind: 9,
      content,
      tags: [
        ["h", request.conversation.channelId],
        ...(root === request.event.id ? [] : [["e", root, "", "root"]]),
        ["e", request.event.id, "", "reply"],
        ["p", request.event.pubkey],
      ],
    });
  }
  private async terminals(rpc: AppServer, threadId: string) {
    // Interrupt acknowledges the turn, not the death of separately grouped shells.
    try {
      await rpc.request("thread/backgroundTerminals/clean", { threadId });
      // clean acknowledges submission. Direct termination is the completion
      // barrier for any shells still reported by the server.
      let cursor: string | null = null;
      do {
        const page: {
          data: { processId: string }[];
          nextCursor: string | null;
        } = await rpc.request("thread/backgroundTerminals/list", {
          threadId,
          limit: 100,
          cursor,
        });
        await Promise.all(
          page.data.map((terminal) =>
            rpc.request("thread/backgroundTerminals/terminate", {
              threadId,
              processId: terminal.processId,
            }),
          ),
        );
        cursor = page.nextCursor;
      } while (cursor);
      const remaining = await rpc.request<{ data: unknown[] }>(
        "thread/backgroundTerminals/list",
        { threadId, limit: 1 },
      );
      if (remaining.data.length)
        throw new Error("Codex background terminals could not be stopped");
    } catch (error) {
      // A failed cleanup must not leave shells unreachable behind an idle lane.
      await rpc.close();
      throw error;
    }
  }
  private async execute(
    request: Request,
    text: string,
    key: string,
    lane: Lane,
    entry: Entry,
  ) {
    let ready!: () => void;
    let notReady!: (error: unknown) => void;
    const active: Active = {
      ready: new Promise((resolve, reject) => {
        ready = resolve;
        notReady = reject;
      }),
      steering: Promise.resolve(),
      reply: request,
      finished: false,
    };
    void active.ready.catch(() => undefined);
    lane.active = active;
    const { settings, agent } = request;
    const signal = AbortSignal.any([
      entry.abort.signal,
      AbortSignal.timeout(29 * 60_000),
    ]);
    let finish!: (status: string) => void;
    let fail!: (error: Error) => void;
    const answers: string[] = [];
    const completed = new Promise<string>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    void completed.catch(() => undefined);
    const abort = () => fail(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    const off = entry.rpc.onMessage((wire) => {
      const p = wire.params as
        | {
            threadId?: string;
            message?: string;
            turn?: { id: string; status: string; error?: { message: string } };
            item?: {
              type: string;
              text?: string;
              phase?: string;
              command?: string;
              aggregatedOutput?: string;
            };
          }
        | undefined;
      if (wire.method === "connection/closed") {
        fail(new Error(p?.message ?? "Codex connection closed"));
        return;
      }
      if (!p || p.threadId !== active.threadId) return;
      if (wire.method === "turn/started" && p.turn) active.turnId = p.turn.id;
      if (
        wire.method === "item/completed" &&
        p.item?.type === "agentMessage" &&
        p.item.phase !== "commentary"
      )
        answers.push(p.item.text ?? "");
      if (wire.method === "item/started" && p.item?.command)
        this.status(agent.pubkey, key, "Working", p.item.command);
      if (
        wire.method === "item/completed" &&
        p.item?.type === "commandExecution"
      )
        this.status(
          agent.pubkey,
          key,
          "Working",
          `${p.item.command ?? ""}\n${p.item.aggregatedOutput ?? ""}`,
        );
      if (wire.method === "turn/completed" && p.turn) {
        active.finished = true;
        if (p.turn.status === "failed")
          fail(new Error(p.turn.error?.message ?? "Codex turn failed"));
        else finish(p.turn.status);
      }
    });
    try {
      const rpc = await entry.opening;
      signal.throwIfAborted();
      const existing = entry.saved[key];
      const normalized = await rpc.request<{
        config: {
          model?: string | null;
          mcp_servers?: Record<string, Record<string, unknown>>;
        };
      }>("config/read", { cwd: settings.workspace });
      const models = await listModels(rpc);
      const model =
        settings.model ||
        normalized.config.model ||
        models.find((row) => row.isDefault)?.model;
      const selected = models.find((row) => row.model === model);
      if (!selected)
        throw new Error(
          "The selected Codex model is unavailable. Choose an available model in Settings.",
        );
      const effort = settings.effort || selected.defaultReasoningEffort;
      const workspace = settings.workspace;
      const mcp = Object.fromEntries(
        Object.entries(normalized.config.mcp_servers ?? {}).map(
          ([name, server]) => [
            name,
            // CLI overrides replace this table; disabled servers still need a transport.
            {
              ...(typeof server.command === "string"
                ? { command: server.command }
                : { url: server.url }),
              enabled: false,
            },
          ],
        ),
      );
      const params = {
        model,
        cwd: workspace,
        developerInstructions: developerInstructions(agent),
        approvalPolicy: "never",
        sandbox: "workspace-write",
        config: {
          "sandbox_workspace_write.network_access": false,
          mcp_servers: mcp,
          "features.plugins": false,
          "features.apps": false,
        },
      };
      const resuming = existing?.workspace === workspace;
      const started = await rpc.request<{
        thread: { id: string; cwd: string };
      }>(resuming ? "thread/resume" : "thread/start", {
        ...params,
        ...(resuming
          ? { threadId: existing?.threadId, excludeTurns: true }
          : {}),
      });
      active.threadId = started.thread.id;
      signal.throwIfAborted();
      this.save(request, entry, key, {
        threadId: started.thread.id,
        workspace,
      });
      await rpc.request("thread/name/set", {
        threadId: active.threadId,
        name: sessionName(agent, request.conversation),
      });
      const context = await this.history(request, signal);
      signal.throwIfAborted();
      const turn = await rpc.request<{ turn: { id: string } }>("turn/start", {
        threadId: active.threadId,
        input: input(
          `${context}${turnInput(request.event, request.conversation, text, request.interest)}`,
        ),
        model,
        effort,
        // Application context is a developer message that updates on each turn.
        additionalContext: {
          "buzz.instructions": {
            kind: "application",
            value: developerInstructions(agent, settings),
          },
        },
      });
      active.turnId = turn.turn.id;
      ready();
      this.status(agent.pubkey, key, "Working");
      const status = await completed;
      await active.steering;
      signal.throwIfAborted();
      if (status === "interrupted") {
        await this.terminals(rpc, active.threadId);
        await this.publish(
          active.reply,
          "Codex’s turn was interrupted. Send another mention to continue.",
        );
        this.status(agent.pubkey, key, "Interrupted");
      } else {
        await this.publish(
          active.reply,
          answers.join("\n\n").trim() ||
            "Codex ended this turn without a final reply. Send another mention to ask it to continue.",
        );
        this.status(agent.pubkey, key, "Idle");
      }
    } catch (error) {
      active.finished = true;
      notReady(error);
      await active.steering;
      if (
        signal.aborted &&
        active.threadId &&
        active.turnId &&
        !entry.abort.signal.aborted
      ) {
        try {
          await entry.rpc.request("turn/interrupt", {
            threadId: active.threadId,
            turnId: active.turnId,
          });
          await this.terminals(entry.rpc, active.threadId);
        } catch {
          await entry.rpc.close();
        }
      }
      if (!entry.abort.signal.aborted) {
        const reason = `Codex could not finish: ${message(error)}.`;
        await this.publish(active.reply, reason).catch((failure) =>
          console.error("Codex could not publish its failure", failure),
        );
        this.status(agent.pubkey, key, "Needs attention", reason);
      }
    } finally {
      signal.removeEventListener("abort", abort);
      off();
      // Release the subscription before the next resume: loaded-thread rejoin
      // ignores instruction/config overrides while a client is subscribed.
      if (active.threadId && !entry.abort.signal.aborted)
        await entry.rpc
          .request("thread/unsubscribe", { threadId: active.threadId })
          .catch(() => entry.rpc.close());
      if (lane.active === active) delete lane.active;
    }
  }
}
const EMPTY: readonly SessionView[] = Object.freeze([]);
