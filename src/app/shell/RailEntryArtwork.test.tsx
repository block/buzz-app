// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { RelaySession } from "../../features/relay/session";
import { RailEntryArtwork } from "./RailEntryArtwork";
import type { RailEntry } from "./rail-pins";

const scope = { viewer: "viewer", communityOrigin: "https://example.org" };
afterEach(cleanup);

// The renderer must choose the shared Avatar's identity shape in Pins as well
// as ordinary rows. Shared Avatar paint is covered by avatar-shapes.spec.mjs.
test.each([
  ["agent", "squircle"],
  ["chat", "squircle"],
  ["agent-dm", "squircle"],
  ["human-dm", "circle"],
] as const)(
  "a pinned %s keeps its identity shape and selection contour",
  (kind, shape) => {
    const profiles = new Map([
      ["member", { name: "Member", isAgent: kind === "agent-dm" }],
    ]);
    const session = {
      viewer: "viewer",
      profiles: { snapshot: () => profiles, subscribe: () => () => {} },
    } as unknown as RelaySession;
    const entry: RailEntry = {
      id: kind,
      label: "Member",
      kind: kind === "agent" || kind === "chat" ? kind : "person",
      target:
        kind === "agent"
          ? { kind: "person", pubkey: "member" }
          : {
              version: 1,
              kind: "conversation",
              scope,
              channelId: "conversation",
            },
    };
    const { container } = render(
      <RailEntryArtwork
        entry={entry}
        avatarOnly
        selected
        session={session}
        channelsById={
          new Map([
            [
              "conversation",
              {
                id: "conversation",
                name: "Member",
                channelType: kind === "chat" ? "solo" : "dm",
                members: ["viewer", "member"],
                participants: ["member"],
              },
            ],
          ])
        }
        resolveName={(_, fallback) => fallback}
        identities={[]}
        agentEntries={[]}
      />,
    );
    for (const avatar of container.querySelectorAll("[data-avatar-shape]"))
      expect(avatar.getAttribute("data-avatar-shape")).toBe(shape);
    expect(container.querySelectorAll("[data-avatar-shape]")).toHaveLength(2);
    expect(container.querySelector("[data-agent]") !== null).toBe(
      shape === "squircle",
    );
  },
);
