import { Service, type Context } from "@deepseek-ai/cordis";
import { createElement, type ComponentType } from "react";
import type { Browser, BrowserViewProps } from "./api";
import { BrowserHostView } from "./BrowserHostView";
import { createBrowserPlatform, type BrowserPlatform } from "./platform";
import { BrowserSessions } from "./sessions";
import { BrowserAccess } from "./control-access";

export class BrowserService extends Service implements Browser {
  readonly View: ComponentType<BrowserViewProps>;
  readonly control: Browser["control"];

  constructor(
    ctx: Context,
    private readonly platform: BrowserPlatform = createBrowserPlatform(),
  ) {
    super(ctx, "browser");
    const control = platform.control;
    const access =
      control &&
      new BrowserAccess(control, (recipient) => {
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
      });
    this.control =
      control && access
        ? Object.freeze({
            available: () => control.available(),
            execute: (agent, context, request) =>
              access.execute(agent, context, request),
          })
        : undefined;
    const sessions = new BrowserSessions(this.platform);
    this.View = (props) =>
      createElement(BrowserHostView, {
        ...props,
        platform: this.platform,
        sessions,
        ...(access && {
          agentControl: { access, agents: ctx.agents, relay: ctx.relay },
        }),
      });
  }
  get available() {
    return this.platform.available;
  }
}
