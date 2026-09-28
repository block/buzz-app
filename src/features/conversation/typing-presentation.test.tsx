// @vitest-environment jsdom
import { createAgentLibrary } from "../agents/library";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { RelaySession } from "../relay/session";
import { TypingIndicator } from "../messages/TypingIndicator";
import {
  TypingPresentation,
  useTypingReplacement,
} from "./typing-presentation";

afterEach(cleanup);
const agent = "a".repeat(64),
  human = "b".repeat(64);
function session() {
  const entries = [undefined, "root", "sibling"].flatMap((threadRootId) => [
    { channelId: "alpha", threadRootId, pubkey: agent },
    { channelId: "alpha", threadRootId, pubkey: human },
  ]);
  // Deliberate namesakes: identity, not display name, controls replacement.
  const profiles = new Map([
    [agent, { name: "Blossom" }],
    [human, { name: "Blossom" }],
  ]);
  return {
    agentChoices: createAgentLibrary(undefined).queries,
    typing: { snapshot: () => entries, subscribe: () => () => {} },
    profiles: { snapshot: () => profiles, subscribe: () => () => {} },
  } as unknown as RelaySession;
}
function Replacement({
  owner,
  channelComposer = true,
}: {
  owner: RelaySession;
  channelComposer?: boolean;
}) {
  useTypingReplacement(
    {
      session: owner,
      channelId: "alpha",
      threadRootId: "root",
      pubkey: agent,
      channelComposer,
    },
    true,
  );
  return <p>Agent activity row</p>;
}
function Indicators({ owner }: { owner: RelaySession }) {
  return (
    <>
      {[undefined, "root", "sibling"].map((threadRootId) => (
        <section
          key={threadRootId ?? "channel"}
          aria-label={threadRootId ?? "channel"}
        >
          <TypingIndicator
            session={owner}
            channelId="alpha"
            threadRootId={threadRootId}
          />
        </section>
      ))}
    </>
  );
}
const label = (scope: string) =>
  within(screen.getByRole("region", { name: scope })).getByRole("status", {
    name: "Typing activity",
  }).textContent;

it("replaces only the displayed scopes and exact identity, and releases tokenized claims", () => {
  const owner = session();
  const tree = (
    count: number,
    active = true,
    channelComposer = true,
    target = owner,
  ) => (
    <TypingPresentation active={active}>
      {["first", "second"].slice(0, count).map((id) => (
        <Replacement key={id} owner={owner} channelComposer={channelComposer} />
      ))}
      <Indicators owner={target} />
    </TypingPresentation>
  );
  const view = render(tree(2), { reactStrictMode: true });
  expect(label("channel")).toBe("Blossom is typing…");
  expect(label("root")).toBe("Blossom is typing…");
  expect(label("sibling")).toBe("Blossom, Blossom are typing…");
  view.rerender(tree(1));
  expect(label("root")).toBe("Blossom is typing…");
  view.rerender(tree(1, true, false));
  expect(label("channel")).toBe("Blossom, Blossom are typing…");
  expect(label("root")).toBe("Blossom is typing…");
  view.rerender(tree(1, false));
  expect(label("root")).toBe("Blossom, Blossom are typing…");
  view.rerender(tree(1, true, true, session()));
  expect(label("root")).toBe("Blossom, Blossom are typing…");
  view.rerender(tree(0));
  expect(label("root")).toBe("Blossom, Blossom are typing…");
});

it("leaves public typing alone outside the workspace provider", () => {
  const owner = session();
  render(
    <>
      <Replacement owner={owner} />
      <Indicators owner={owner} />
    </>,
    { reactStrictMode: true },
  );
  expect(label("channel")).toBe("Blossom, Blossom are typing…");
  expect(label("root")).toBe("Blossom, Blossom are typing…");
});
