// The Runner: it runs agents, owns the agent storage they keep, and has what
// plugins' agent entries add for them. It reaches the Manager only over its
// link, so a page can build it without the screens.
import { Service, type Context } from "@deepseek-ai/cordis";
import type {} from "../navigation/service";
import type { AddedTool } from "../../buzz-mcp/session-tools";
import { createContributions } from "../../plugins/contributions";
import type { Decisions } from "../decisions/service";
import { AgentsRunner } from "./agents-runner";
import { originOf } from "./connections";
import type { AttentionSource } from "./attention-sources";
import {
  createAgentHooks,
  dispatchAgentHooks,
  type AgentHook,
  type AgentHookContext,
} from "./hooks";
import { bindKeepAwake } from "./keep-awake";
import type { RuntimeLink } from "./exposed";
import type { LinkPort } from "./link";
import type { LocalAgentActivity } from "./local-activity";
import type { AgentKey } from "./membership";
import type { AgentsNative } from "./native";
import { TIMEOUT_LIMIT_MS } from "./runner";
import { routed, runnerSide } from "./runner-link";
import { RunnerPlugins } from "./runner-plugins";
import type {
  Agent,
  AgentCommunities,
  AgentType,
  AgentWake,
  RegisteredAgentType,
} from "./service";
import type { AgentProtection } from "../agent-protection/service";
import { PRESENTED } from "./shown-types";
import type { AgentStore } from "./state";
import { setAttention, type AgentRecord } from "./store";

/** How often each runner is woken, to start any timer that is due. */
const TIMER_TICK_MS = 5_000;

/** A new agent's settings: its type's defaults. */
export function defaults(pubkey: string, type: RegisteredAgentType) {
  const { config, attention = {} } = type.defaults();
  let record: AgentRecord = { pubkey, attention: {}, config };
  for (const [slug, value] of Object.entries(attention))
    record = setAttention(record, slug, value);
  return record;
}

/** Throws unless `type` is a whole agent type: one that runs here, or a
 * hosted one. */
export function checkType(type: AgentType<unknown>) {
  if (
    !/^[a-z0-9][a-z0-9._-]*$/.test(type.id ?? "") ||
    !type.title ||
    typeof type.defaults !== "function"
  )
    throw new Error("Agent types need an id, a title and defaults");
  if (
    type.timeoutMs !== undefined &&
    !(
      Number.isInteger(type.timeoutMs) &&
      type.timeoutMs >= 1 &&
      type.timeoutMs <= TIMEOUT_LIMIT_MS
    )
  )
    throw new Error(
      `Agent type timeoutMs must be a whole number from 1 to ${TIMEOUT_LIMIT_MS}`,
    );
  const { remote } = type;
  if (
    remote &&
    (type.run ||
      type.models ||
      type.timeoutMs !== undefined ||
      (["provision", "activate", "profile", "remove"] as const).some(
        (step) => typeof remote[step] !== "function",
      ))
  )
    throw new Error(
      "A hosted agent type has provision, activate, profile and remove, and no run, models or timeoutMs",
    );
  // A type that runs here may run in another page than its UI.
  const shown = remote
    ? undefined
    : (PRESENTED.find((field) => type[field] !== undefined) ??
      (type.sessionControls?.scope && "sessionControls.scope") ??
      (type.provider?.DialogBody && "provider.DialogBody") ??
      (type.provider?.DefaultControl && "provider.DefaultControl"));
  if (shown)
    throw new Error(
      `An agent type that runs here gives ${shown} from its plugin's present`,
    );
}

export type RunnerOptions = Readonly<{
  communities: AgentCommunities;
  native: AgentsNative | undefined;
  storage: AgentStore;
  localActivity: LocalAgentActivity;
  decisions: Decisions | undefined;
  /** The protection a protected agent's run checks its actions with, from
   * the agentProtection service of this page. */
  protection?: (agent: Agent) => AgentProtection | undefined;
}>;

/** The Runner, with its side of the link on `port`. What a plugin calls
 * takes that plugin's `ctx`. */
export class AgentsRunnerService {
  /** The agent types that run here. */
  private readonly types;
  private readonly hooks;
  private readonly runner: AgentsRunner;
  private readonly plugins: RunnerPlugins;
  private readonly link: ReturnType<typeof runnerSide>;

  constructor(ctx: Context, port: LinkPort, options: RunnerOptions) {
    const { communities, storage, native, localActivity, decisions } = options;
    this.types = createContributions<AgentType>(ctx);
    this.hooks = createAgentHooks(ctx);
    this.runner = new AgentsRunner(storage, native, localActivity, decisions, {
      open: (origin) => communities.open(origin),
      types: () => this.types.snapshot(),
      defaults,
      // What the Runner asks of the Manager crosses the link.
      createAgent: (agent, input) => this.link.createAgent(agent, input),
      updateAgent: (agent, input) => this.link.updateAgent(agent, input),
      templates: (agent) => this.link.templates(agent),
      publishType: (key, type, config) =>
        this.link.publishType(key, type, config),
      finished: (key) => this.link.finished(key),
      refresh: () => this.link.refresh(),
      navigation: ctx.navigation,
      protection: (agent) => options.protection?.(agent),
    });
    this.plugins = new RunnerPlugins(ctx, this.runner);
    this.link = runnerSide(port, this.runner);
    if (native)
      ctx.effect(() =>
        bindKeepAwake(this.runner.runners, (hold) => native.keepAwake(hold)),
      );
    ctx.effect(() => {
      const stops = [
        this.types.subscribe(() => {
          this.hooks.validate(this.types.snapshot());
          this.runner.typesChanged();
        }),
        communities.subscribe(() =>
          this.runner.communitiesChanged(communities.snapshot().viewer),
        ),
      ];
      // Wakes each runner, which starts any timer that is due.
      const tick = setInterval(() => {
        this.runner.runners.tick();
        this.runner.connections.reconnect(
          originOf(communities.snapshot().selected ?? ""),
        );
        this.runner.presence.announce();
        this.runner.runners.catchUp(true);
      }, TIMER_TICK_MS);
      return () => {
        clearInterval(tick);
        for (const stop of stops) stop();
        // Nothing the link sends now may start runners again.
        this.link.close();
        this.runner.clear();
      };
    });
  }

  register(ctx: Context, type: AgentType<unknown>) {
    checkType(type);
    if (type.remote) throw new Error("A hosted agent type runs elsewhere");
    this.types.register(ctx, type as AgentType);
  }
  registerHook(ctx: Context, hook: AgentHook) {
    const adapter = this.types
      .snapshot()
      .find((type) => type.key === hook.harness);
    if (adapter && !adapter.hooks?.events.includes(hook.event))
      throw new Error(
        `Hook event ${hook.event} is not supported by ${hook.harness}`,
      );
    this.hooks.register(ctx, hook);
  }
  dispatchHook(
    ctx: Context,
    harness: string,
    event: string,
    input: unknown,
    context: AgentHookContext,
    options: { accepts(output: unknown): boolean; milliseconds: number },
  ) {
    const owner = ctx.pluginOwner;
    if (!owner || !harness.startsWith(`${owner.id}/`))
      throw new Error(
        "Plugins can dispatch hooks only for their own agent types",
      );
    return dispatchAgentHooks(
      this.hooks.handlers(harness, event),
      input,
      context,
      options.accepts,
      options.milliseconds,
    );
  }
  /** The link to what `ctx`'s plugin's UI shares. */
  shared(ctx: Context) {
    const plugin = ctx.pluginOwner?.id;
    if (!plugin) throw new Error("Only a plugin reaches what its UI shares");
    const reached = routed(this.link, "plugin", { plugin });
    ctx.effect(() => () => reached.close());
    return reached as RuntimeLink;
  }
  addTool(ctx: Context, tool: AddedTool) {
    this.plugins.addTool(ctx, tool);
  }
  addAttentionSource(ctx: Context, source: AttentionSource) {
    this.plugins.addAttentionSource(ctx, source);
  }
  attentionProviders = () => this.plugins.attentionProviders();
  tools = () => this.plugins.tools();
  wake(ctx: Context, key: AgentKey, wake: AgentWake) {
    const plugin = ctx.pluginOwner?.id;
    if (!plugin) throw new Error("Only a plugin wakes an agent");
    this.runner.wake(key, wake, { plugin });
  }
  handle(ctx: Context, key: AgentKey) {
    const owner = ctx.pluginOwner;
    return owner && this.runner.runners.handle(key, owner.id);
  }
  note(key: AgentKey, channelId: string, text: string, root?: string) {
    return this.runner.runners.note(key, channelId, text, root);
  }
  relay = (key: AgentKey) => this.runner.relay(key);
  core = (key: AgentKey, signal?: AbortSignal) =>
    this.runner.coreMemory.core(key, signal);
  /** What this page's agentProtection reads: the agents running here, and
   * the types that run here. */
  running = () => this.runner.running();
  agentTypes = () => this.types.snapshot();
  /** Saves `pubkey`'s protection policy once its sessions are retired. */
  protect = (
    pubkey: string,
    revision: number,
    provider: string,
    policy: unknown,
  ) => this.runner.protect(pubkey, revision, provider, policy);
}

/** `ctx.agents` in a page that runs only the Runner: what plugins' agent
 * entries use. The members the screens use are the Manager's page's. */
export class RunnerAgents extends Service {
  constructor(
    ctx: Context,
    private readonly runner: AgentsRunnerService,
  ) {
    super(ctx, "agents");
  }
  register<Config>(type: AgentType<Config>) {
    this.runner.register(this.ctx, type as unknown as AgentType);
  }
  registerHook(hook: AgentHook) {
    this.runner.registerHook(this.ctx, hook);
  }
  dispatchHook(
    harness: string,
    event: string,
    input: unknown,
    context: AgentHookContext,
    options: { accepts(output: unknown): boolean; milliseconds: number },
  ) {
    return this.runner.dispatchHook(
      this.ctx,
      harness,
      event,
      input,
      context,
      options,
    );
  }
  shared() {
    return this.runner.shared(this.ctx);
  }
  addTool(tool: AddedTool) {
    this.runner.addTool(this.ctx, tool);
  }
  addAttentionSource(source: AttentionSource) {
    this.runner.addAttentionSource(this.ctx, source);
  }
  attentionProviders = () => this.runner.attentionProviders();
  tools = () => this.runner.tools();
  wake(key: AgentKey, wake: AgentWake) {
    this.runner.wake(this.ctx, key, wake);
  }
  handle(key: AgentKey) {
    return this.runner.handle(this.ctx, key);
  }
  note(key: AgentKey, channelId: string, text: string, root?: string) {
    return this.runner.note(key, channelId, text, root);
  }
  relay = (key: AgentKey) => this.runner.relay(key);
  core = (key: AgentKey, signal?: AbortSignal) => this.runner.core(key, signal);
}
