// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { LocalDecline } from "../agents/local-activity";
import { AgentDeclineNotes } from "./AgentDeclineNotes";

afterEach(cleanup);
const agent = "a".repeat(64),
  other = "c".repeat(64),
  message = "b".repeat(64);
const choices = { identities: [{ pubkey: agent, name: "Builder" }] };
const session = (declined: LocalDecline[]) =>
  ({
    agentActivity: {
      snapshot: () => ({ declined }),
      subscribe: () => () => {},
    },
    agentChoices: {
      snapshot: () => choices,
      subscribe: () => () => {},
    },
  }) as never;
const decline = (refusal: LocalDecline["refusal"], who = agent) => ({
  scope: "s",
  agent: who,
  channelId: "channel",
  messageId: message,
  refusal,
});

it("says which agent didn't act and why", () => {
  render(
    <AgentDeclineNotes
      session={session([decline("sender"), decline("workflow", other)])}
      channelId="channel"
      messageId={message}
    />,
  );
  expect(
    screen.getByText("Builder only responds to your messages."),
  ).toBeInTheDocument();
  expect(
    screen.getByText(
      "Your agent didn't respond to this workflow message. This community limits which workflows can use agents, so other people can't use yours. The workflow's Runs tab shows why it didn't respond this time.",
    ),
  ).toBeInTheDocument();
});

it("shows nothing for another message", () => {
  const { container } = render(
    <AgentDeclineNotes
      session={session([decline("sender")])}
      channelId="channel"
      messageId={other}
    />,
  );
  expect(container).toBeEmptyDOMElement();
});
