import { expect, it } from "vitest";
import { DiscoveryState } from "./discovery";
import { keypair, roster, signed } from "./testing";
import { SOLO_LABEL } from "../solo/labels";
it("recognizes only relay-authorized private streams with the Solo label", () => {
  const viewer = keypair(),
    relay = keypair();
  const discovery = new DiscoveryState(viewer.pubkey, relay.pubkey);
  discovery.accept(roster(relay, "work", [viewer.pubkey]));
  const metadata = (
    author: typeof relay,
    privateChannel: boolean,
    time: number,
  ) =>
    signed(author, {
      kind: 39000,
      created_at: time,
      content: "",
      tags: [
        ["d", "work"],
        ["name", "Work"],
        ["t", "stream"],
        ["t", SOLO_LABEL],
        ["about", "Plain text"],
        ...(privateChannel ? [["private"]] : []),
      ],
    });
  discovery.accept(metadata(viewer, true, 1));
  expect(discovery.isSession("work")).toBe(false);
  discovery.accept(metadata(relay, false, 1));
  expect(discovery.isSession("work")).toBe(false);
  discovery.accept(metadata(relay, true, 2));
  expect(discovery.channels()[0]).toMatchObject({
    channelType: "session",
    description: "Plain text",
    labels: [SOLO_LABEL],
    private: true,
  });
  discovery.accept(
    signed(relay, {
      kind: 39000,
      created_at: 3,
      content: "",
      tags: [
        ["d", "work"],
        ["t", "session"],
      ],
    }),
  );
  expect(discovery.isSession("work")).toBe(false);
});

it("leaves a channel with only the retired about marker an ordinary stream", () => {
  const viewer = keypair(),
    relay = keypair();
  const id = "22222222-2222-4222-8222-222222222222";
  const discovery = new DiscoveryState(viewer.pubkey, relay.pubkey);
  discovery.accept(roster(relay, id, [viewer.pubkey]));
  discovery.accept(
    signed(relay, {
      kind: 39000,
      content: "",
      tags: [
        ["d", id],
        ["t", "stream"],
        ["private"],
        ["name", "Work"],
        ["about", "Buzz session (buzz.sessions/v1)\npersonal"],
      ],
    }),
  );
  expect(discovery.isSession(id)).toBe(false);
  expect(discovery.channels()[0]).toMatchObject({ channelType: "stream" });
});
