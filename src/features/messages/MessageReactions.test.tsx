// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MessageReactionControls, MessageReactions } from "./MessageReactions";
import { createRelaySession } from "../relay/session";
import {
  flush,
  keypair,
  message,
  roster,
  scriptedTransport,
  signed,
} from "../relay/testing";
import type { LiveCallbacks } from "../relay/live";
import type { RelayEvent } from "../relay/events";
import type {
  ComposerTool,
  ContributionReader,
  InlineRenderer,
} from "../conversation/contracts";
import { PublishRejected } from "../relay/outbox";
import { useSyncExternalStore } from "react";

const viewer = keypair(),
  other = keypair(),
  relay = keypair();
const owners: { dispose(): void }[] = [];
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  localStorage.clear();
});
const registry = <T,>(
  entries: ReturnType<ContributionReader<T>["snapshot"]>,
): ContributionReader<T> => ({
  snapshot: () => entries,
  subscribe: () => () => {},
});
const inline = registry<InlineRenderer>([]);
const tools = registry<ComposerTool>([]);
const root = message(other, "c", "Message", 1);
const react = (key = viewer, time = 2) =>
  signed(key, {
    kind: 7,
    content: "👍",
    created_at: time,
    tags: [
      ["h", "c"],
      ["e", root.id],
    ],
  });
function harness(
  events: RelayEvent[] = [],
  publish = vi.fn(async (_event: RelayEvent) => {}),
) {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession(
    {
      ...wire.transport,
      writer: { sign: async (template) => signed(viewer, template), publish },
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  owners.push(owner);
  owner.session.channels.ensure("c");
  live.receive([roster(relay, "c", [viewer.pubkey], 1), root, ...events]);
  function Controls({ disabled = false }: { disabled?: boolean }) {
    const state = useSyncExternalStore(
      (fn) => owner.session.channels.subscribeWindow("c", fn),
      () => owner.session.channels.window("c"),
    );
    const row = state.rows[0];
    return (
      row && (
        <>
          <MessageReactionControls
            row={row}
            session={owner.session}
            scope="test"
            disabled={disabled}
            tools={tools}
            inline={inline}
          />
          <MessageReactions
            row={row}
            session={owner.session}
            scope="test"
            disabled={disabled}
            tools={tools}
            inline={inline}
          />
        </>
      )
    );
  }
  return { ...owner, live, publish, Controls };
}
it("shows three shortcuts and groups distinct people while removing all own duplicates", async () => {
  const mine = react(),
    duplicate = react(viewer, 3),
    theirs = react(other);
  const h = harness([mine, duplicate, theirs]);
  render(<h.Controls />);
  expect(
    screen.getAllByRole("button", { name: /React with|Remove/ }),
  ).toHaveLength(3);
  const grouped = screen.getByRole("button", {
    name: "👍: 2 people, including you",
  });
  expect(grouped.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(grouped);
  const operation = h.session.outbox?.snapshot()[0];
  expect(operation?.event).toMatchObject({
    kind: 5,
    tags: expect.arrayContaining([
      ["e", mine.id],
      ["e", duplicate.id],
    ]),
  });
  expect(operation?.event.tags).not.toContainEqual(["e", theirs.id]);
  expect(
    screen
      .getByRole("button", { name: "👍: 1 person" })
      .getAttribute("aria-pressed"),
  ).toBe("false");
  await act(async () => {
    await flush();
    await flush();
  });
});
it("keeps failed first-reaction delivery visible and retries the same event", async () => {
  const publish = vi.fn(async (_event: RelayEvent) => {
    throw new PublishRejected("Nope");
  });
  const h = harness([], publish);
  render(<h.Controls />);
  fireEvent.click(screen.getByRole("button", { name: "React with ❤️" }));
  await act(async () => {
    await flush();
    await flush();
  });
  expect(screen.queryByRole("button", { name: /❤️: 1/ })).toBeNull();
  const original = publish.mock.calls[0]?.[0];
  publish.mockImplementation(async () => undefined as never);
  fireEvent.click(screen.getByRole("button", { name: "Retry reaction" }));
  await act(async () => {
    await flush();
    await flush();
  });
  expect(publish.mock.calls[1]?.[0]).toEqual(original);
});
it("prevents duplicate submissions and unavailable-message actions", async () => {
  const h = harness();
  const view = render(<h.Controls disabled />);
  fireEvent.click(screen.getByRole("button", { name: "React with 👍" }));
  expect(h.session.outbox?.snapshot()).toHaveLength(0);
  view.rerender(<h.Controls />);
  const button = screen.getByRole("button", { name: "React with 👍" });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(h.session.outbox?.snapshot()).toHaveLength(1);
  await act(async () => {
    await flush();
    await flush();
  });
});
