import { Service, type Context } from "@deepseek-ai/cordis";
import { createElement, type ComponentType } from "react";
import type { Browser, BrowserViewProps } from "./api";
import { BrowserHostView } from "./BrowserHostView";
import { createBrowserPlatform, type BrowserPlatform } from "./platform";
import { BrowserSessions } from "./sessions";
import {
  BrowserAccess,
  type BrowserInitialShare,
  type BrowserRecipient,
} from "./control-access";
import { validateBrowsableUrl } from "./platform";
import { withTimeout } from "../../plugins/timeout";

export class BrowserService extends Service implements Browser {
  readonly View: ComponentType<BrowserViewProps>;
  readonly control: Browser["control"];

  constructor(
    ctx: Context,
    private readonly platform: BrowserPlatform = createBrowserPlatform(),
  ) {
    super(ctx, "browser");
    const control = platform.control;
    const eligible = (recipient: BrowserRecipient) => {
      const connection = ctx.relay?.snapshot();
      if (
        connection?.status !== "ready" ||
        connection.cached ||
        connection.scope !== recipient.scope
      )
        return false;
      const session = connection.session;
      const channel = session.channels
        .list()
        .channels.find((item) => item.id === recipient.channel);
      const agent = ctx.agents
        ?.snapshot()
        .running.find((item) => item.key === recipient.agent);
      return (
        !!agent &&
        agent.place === "here" &&
        agent.owner === connection.viewer &&
        !!channel &&
        !channel.archived &&
        !channel.readOnly &&
        !channel.cached &&
        !!channel.members?.includes(agent.pubkey) &&
        !!session.agentChoices
          .snapshot()
          .selectable.some((item) => item.pubkey === agent.pubkey) &&
        ctx.agents.relay(agent.key)?.snapshot().scope === recipient.scope
      );
    };
    const access = control && new BrowserAccess(control, eligible);
    const sessions = new BrowserSessions(this.platform);
    const render = (
      props: BrowserViewProps,
      initialShare?: BrowserInitialShare,
      sessionKey?: string,
      allowAgentControl = false,
    ) =>
      createElement(BrowserHostView, {
        ...props,
        initialShare,
        sessionKey,
        allowAgentControl,
        platform: this.platform,
        sessions,
        ...(access && {
          agentControl: { access, agents: ctx.agents, relay: ctx.relay },
        }),
      });
    const openings = new Map<
      string,
      { initial: BrowserInitialShare; recipient: BrowserRecipient }
    >();
    const pendingRecipients = new Set<string>();
    const prefix = "buzz-browser-control:";
    const openingUrl = (target: string) => {
      if (!target.startsWith(prefix)) return undefined;
      try {
        const params = new URL(target).searchParams;
        const valid = validateBrowsableUrl(params.get("url") ?? "");
        const storage = params.get("storage");
        return valid.ok
          ? {
              url: valid.url,
              ...(storage && { storage }),
            }
          : undefined;
      } catch {
        return undefined;
      }
    };
    this.control =
      control && access
        ? Object.freeze({
            available: () => control.available(),
            Page: (props) => render(props, undefined, undefined, true),
            View: ({ target, conversation }) => {
              const page = openingUrl(target);
              if (!page) return null;
              const opening = openings.get(target);
              const sameConversation =
                opening &&
                conversation?.channel === opening.recipient.channel &&
                conversation?.root === opening.recipient.root;
              return render(
                { ...page, conversation },
                sameConversation ? opening.initial : undefined,
                target,
                true,
              );
            },
            open: async (agentKey, context, options) => {
              if (!this.available || !(await control.available()))
                throw new Error(
                  "Browser control is unavailable in this build.",
                );
              const valid = validateBrowsableUrl(options.url);
              if (!valid.ok) throw new Error(valid.reason);
              const connection = ctx.relay?.snapshot();
              const agent = ctx.agents
                ?.snapshot()
                .running.find((item) => item.key === agentKey);
              if (!context.channel || !agent || !connection?.scope)
                throw new Error(
                  "A local agent and conversation are required to open a browser.",
                );
              const recipient = {
                agent: agentKey,
                scope: connection.scope,
                channel: context.channel,
                root: context.topLevel ? undefined : context.root,
              };
              const authorized = () => eligible(recipient);
              if (!authorized())
                throw new Error(
                  "This agent cannot open a browser in this conversation.",
                );
              const recipientKey = JSON.stringify(recipient);
              if (pendingRecipients.has(recipientKey))
                throw new Error(
                  "A browser is already opening for this conversation. Wait for it to finish.",
                );
              pendingRecipients.add(recipientKey);
              const params = new URLSearchParams({ url: valid.url });
              if (options.storage) params.set("storage", options.storage);
              const target = `${prefix}${crypto.randomUUID()}?${params}`;
              let claimed = false;
              let settle!: (error?: unknown) => void;
              const ready = new Promise<void>((resolve, reject) => {
                settle = (error) => (error ? reject(error) : resolve());
              });
              void ready.catch(() => undefined);
              const initial: BrowserInitialShare = {
                agent: agent.pubkey,
                valid: () =>
                  openings.get(target)?.initial === initial && authorized(),
                prepare: () => access.revokeRecipient(recipient),
                claim: () => {
                  if (
                    claimed ||
                    openings.get(target)?.initial !== initial ||
                    !authorized()
                  )
                    return false;
                  claimed = true;
                  return true;
                },
                complete: settle,
              };
              openings.set(target, { initial, recipient });
              try {
                if (
                  !ctx.panels.requestOpen({
                    target,
                    channelId: recipient.channel,
                    ...(recipient.root && { rootId: recipient.root }),
                  })
                )
                  throw new Error(
                    "Keep this conversation visible in Buzz to open a browser.",
                  );
                await withTimeout(
                  ready,
                  "Browser did not become ready. Keep it visible and try again.",
                );
                return { opened: true, url: valid.url };
              } finally {
                openings.delete(target);
                pendingRecipients.delete(recipientKey);
              }
            },
            execute: (agent, context, request) =>
              access.execute(agent, context, request),
          })
        : undefined;
    this.View = (props) => render(props);
  }
  get available() {
    return this.platform.available;
  }
}
