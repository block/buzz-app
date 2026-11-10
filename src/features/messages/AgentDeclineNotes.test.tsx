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
    screen.getByText("Builder acts only on messages from you."),
  ).toBeInTheDocument();
  expect(
    screen.getByText(
      "Your agent didn't act: workflow messages direct agents only when you or a timer start the run.",
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
