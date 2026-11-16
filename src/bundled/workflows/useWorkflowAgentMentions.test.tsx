// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { AgentDeclineNotes } from "../../features/messages/AgentDeclineNotes";

const native = vi.hoisted(() => ({ relayInfo: vi.fn() }));
vi.mock("../../features/relay/native", () => ({
  nativeRelayInfo: native.relayInfo,
}));
vi.mock("../../features/identity/service", () => ({
  nativeIdentityEnabled: () => true,
}));

const scope = `https://relay.example:${"d".repeat(64)}`;
const agent = "a".repeat(64);
const messages = ["1", "2", "3"].map((n) => n.repeat(64));
const session = {
  agentActivity: {
    snapshot: () => ({
      declined: messages.map((messageId) => ({
        scope,
        agent,
        channelId: "channel",
        messageId,
        refusal: "workflow",
      })),
    }),
    subscribe: () => () => {},
  },
} as never;
const notes = () =>
  render(
    messages.map((id) => (
      <AgentDeclineNotes
        key={id}
        session={session}
        scope={scope}
        channelId="channel"
        messageId={id}
      />
    )),
  );

it("shares one relay read across notes, and retries after a failure", async () => {
  native.relayInfo.mockRejectedValueOnce(new Error("offline"));
  notes();
  await new Promise((done) => setTimeout(done));
  cleanup();
  expect(native.relayInfo).toHaveBeenCalledTimes(1);

  native.relayInfo.mockResolvedValue({ workflow_agent_mentions: "owner" });
  notes();
  expect(await screen.findAllByText(/limits which workflows/)).toHaveLength(3);
  cleanup();
  notes();
  expect(await screen.findAllByText(/limits which workflows/)).toHaveLength(3);
  expect(native.relayInfo).toHaveBeenCalledTimes(2);
  expect(native.relayInfo).toHaveBeenCalledWith("https://relay.example");
});
