// What plugins' agent entries add to the Runner: tools that agent turns can
// call, and attention sources that wake agents. Both run with the agents, so
// they are the Runner's.
import type { Context } from "@deepseek-ai/cordis";
import { appClient } from "../../buzz-mcp/app-client";
import { connectMcp } from "../../buzz-mcp/connection";
import { respond } from "../../buzz-mcp/rpc";
import { type AddedTool, BUZZ_SESSION } from "../../buzz-mcp/session-tools";
import {
  createContributions,
  type Contribution,
} from "../../plugins/contributions";
import type {
  HostMcpServer,
  HostProcess,
  HostProcessOptions,
} from "../host/service";
import type { AgentsRunner } from "./agents-runner";
import { sourceCompleted } from "./attention";
import {
  AttentionSources,
  type AttentionProducer,
  type AttentionSource,
} from "./attention-sources";
import { spawnAgentCommand } from "./command";
import { pubkeyOf, type AgentKey } from "./membership";
import { ownerReads } from "./reads";
import { soloChat } from "./solo-chat";

const serializable = (value: unknown) => {
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
};

export class RunnerPlugins {
  private readonly addedTools;
  /** Every added tool's name, its plugin active or still starting. */
  private readonly toolNames = new Set<string>();
  private readonly attentionSources;
  private readonly sourceTails = new Map<string, Promise<void>>();

  constructor(
    ctx: Context,
    private readonly runner: Pick<
      AgentsRunner,
      "runners" | "records" | "running" | "relay" | "subscribe"
    >,
  ) {
    this.addedTools = createContributions<AddedTool & { id: string }>(ctx);
    this.attentionSources = createContributions<AttentionProducer>(ctx);
    ctx.effect(() => {
      const running = new Map<Contribution<AttentionProducer>, () => void>();
      const reconcile = () => {
        const active = this.attentionSources.snapshot();
        for (const [source, stop] of running) {
          if (active.includes(source)) continue;
          stop();
          running.delete(source);
        }
        for (const source of active) {
          if (!running.has(source))
            running.set(source, this.startAttentionSource(source));
        }
      };
      const unsubscribe = this.attentionSources.subscribe(reconcile);
      reconcile();
      return () => {
        unsubscribe();
        for (const stop of running.values()) stop();
      };
    });
  }

  addTool(ctx: Context, tool: AddedTool) {
    if (
      !/^[a-z][a-z0-9_]{0,63}$/.test(tool.name ?? "") ||
      BUZZ_SESSION.tools.some((core) => core.name === tool.name) ||
      !tool.description ||
      tool.inputSchema?.type !== "object" ||
      !serializable(tool.inputSchema) ||
      typeof tool.call !== "function"
    )
      throw new Error(
        "Agent tools need a lowercase name no Buzz tool has, a description, a JSON object inputSchema and call",
      );
    // Reserved from registration, not activation: plugins starting together
    // are not active yet, and the second to take a name must fail.
    if (this.toolNames.has(tool.name))
      throw new Error(`Another plugin adds agent tool ${tool.name}`);
    this.addedTools.register(ctx, { ...tool, id: tool.name });
    ctx.effect(() => {
      this.toolNames.add(tool.name);
      return () => this.toolNames.delete(tool.name);
    });
  }
  addAttentionSource(ctx: Context, source: AttentionSource) {
    const plugin = ctx.pluginOwner?.id;
    if (
      !plugin ||
      !/^[a-z0-9][a-z0-9._-]*$/.test(source.id) ||
      typeof source.run !== "function" ||
      (source.description !== undefined &&
        (typeof source.description !== "string" ||
          !source.description.trim())) ||
      (source.configExample !== undefined &&
        (!source.configExample ||
          typeof source.configExample !== "object" ||
          Array.isArray(source.configExample) ||
          !serializable(source.configExample)))
    )
      throw new Error(
        "A plugin source needs an id, run and valid discovery metadata",
      );
    const connect = async (
      key: AgentKey,
      options: Readonly<{
        signal: AbortSignal;
        channel?: string | undefined;
        root?: string | undefined;
        cwd?: string;
      }>,
    ): Promise<HostMcpServer> => {
      if (!ctx.pluginOwner)
        throw new Error("Only an installed plugin connects as an agent");
      options.signal.throwIfAborted();
      const handle = this.runner.runners.handle(key);
      if (!handle) throw new Error("This agent is not running here");
      const host = ctx.host;
      if (!host?.serveMcp)
        throw new Error("Agent connections require a desktop MCP host");
      const reads = () => {
        const source = ownerReads(this.runner.relay(key), pubkeyOf(key));
        if (!source) throw new Error("The agent's community is not connected");
        return source;
      };
      const source = reads();
      const topLevel =
        options.channel !== undefined &&
        (await soloChat(
          () => this.runner.relay(key),
          handle.owner,
          options.channel,
          options.signal,
        ));
      return connectMcp(
        host.serveMcp.bind(host),
        (signal) => {
          const client = appClient(handle, {
            signal,
            relayAuthor: source.relayAuthor?.(),
            signingAuthority: source.workflowAuthority(),
            check: () => {
              handle.attention.enabled();
              if (reads().connection !== source.connection)
                throw new Error("The agent's community connection changed");
            },
            read: async (path) => {
              if (!host.readFile)
                throw new Error("This plugin cannot read local files");
              return host.readFile(
                path,
                options.cwd === undefined ? undefined : { cwd: options.cwd },
              );
            },
            memories: (slug) => reads().memoryListing(signal, slug),
          });
          return (message) =>
            respond(
              client,
              {
                ...(options.channel === undefined
                  ? {}
                  : { channel: options.channel }),
                ...(topLevel
                  ? { topLevel: true }
                  : options.root === undefined
                    ? {}
                    : { root: options.root }),
              },
              message,
            );
        },
        options.signal,
      );
    };
    const spawn = async (
      key: AgentKey,
      process: string,
      options: Omit<HostProcessOptions, "mcp"> & {
        signal: AbortSignal;
        channel?: string | undefined;
        root?: string | undefined;
      },
    ): Promise<HostProcess> => {
      options.signal.throwIfAborted();
      const host = ctx.host;
      if (!host?.spawn)
        throw new Error("Agent commands require a desktop process host");
      const handle = this.runner.runners.handle(key);
      if (!handle) throw new Error("This agent is not running here");
      const source = ownerReads(this.runner.relay(key), pubkeyOf(key));
      if (!source) throw new Error("The agent's community is not connected");
      const spawn = host.spawn.bind(host);
      return spawnAgentCommand(
        {
          connect: (signal) => connect(key, { ...options, signal }),
          spawn: (settings) => spawn(process, settings),
          subscribe: (changed) => {
            const agent = this.runner.subscribe(changed);
            const community = this.runner.relay(key)?.subscribe(changed);
            return () => {
              agent();
              community?.();
            };
          },
          check: () => {
            if (!handle.attention.enabled())
              throw new Error("Attention is off");
            if (
              ownerReads(this.runner.relay(key), pubkeyOf(key))?.connection !==
              source.connection
            )
              throw new Error("The agent's community connection changed");
          },
        },
        options,
      );
    };
    this.attentionSources.register(ctx, {
      ...source,
      run: async (input) => {
        const {
          agent,
          watch: { channel, root },
        } = input;
        const completed = new AbortController();
        const signal = AbortSignal.any([input.signal, completed.signal]);
        try {
          await source.run({
            ...input,
            spawn: (process, options) =>
              spawn(agent, process, {
                ...options,
                signal,
                channel,
                root,
              }),
          });
        } finally {
          completed.abort();
        }
      },
      ...(source.configExample === undefined
        ? {}
        : { configExample: JSON.parse(JSON.stringify(source.configExample)) }),
    });
  }
  attentionProviders = () =>
    this.attentionSources
      .snapshot()
      .map(({ key: provider, description, configExample }) => ({
        provider,
        ...(description === undefined ? {} : { description }),
        ...(configExample === undefined
          ? {}
          : { configExample: JSON.parse(JSON.stringify(configExample)) }),
      }));
  private startAttentionSource(source: Contribution<AttentionProducer>) {
    const sources = new AttentionSources(
      {
        completed: (key, object) =>
          sourceCompleted(this.runner.records.saved(key)?.sourceRuns, object),
        finish: (key, object) =>
          this.runner.runners.completeSource(key, object),
        emit: (key, object, text, current) => {
          const agent = this.runner
            .running()
            .find((agent) => agent.key === key);
          if (
            !agent?.attentionEnabled ||
            agent.attention[object.slug] !== object ||
            !object.value.enabled
          )
            throw new Error("This source watch is no longer enabled");
          this.runner.records.history(key, object, text);
          this.runner.runners.wakeSource(
            key,
            {
              type: "source",
              slug: object.slug,
              watch: object.value,
              plugin: source.pluginId,
              text,
            },
            object,
            current,
          );
        },
      },
      this.sourceTails,
    );
    const update = () =>
      sources.reconcile(
        source.key,
        source,
        this.runner
          .running()
          .filter((agent) => this.runner.runners.runs(agent.key)),
      );
    const unsubscribe = this.runner.subscribe(update);
    update();
    return () => {
      unsubscribe();
      sources.stop();
    };
  }
  tools = () => this.addedTools.snapshot();
}
