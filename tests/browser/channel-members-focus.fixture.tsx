import { createRoot } from "react-dom/client";
import { ChannelMembersButton } from "../../src/bundled/channels/ChannelMembersDialog";
import { createRelaySession } from "../../src/features/relay/session";
import { matchesEvent } from "../../src/features/relay/projection";
import {
  keypair,
  profile,
  roster,
  signed,
} from "../../src/features/relay/testing";
import "../../src/shared/styles/globals.css";

const viewer = keypair();
const relay = keypair();
const person = keypair();
const channelId = "11111111-1111-4111-8111-111111111111";
const members = [viewer.pubkey];
let clock = 1700000000;
let publishStarted = () => {};
let releasePublish = () => {};
const published = new Promise<void>((resolve) => {
  publishStarted = resolve;
});
const held = new Promise<void>((resolve) => {
  releasePublish = resolve;
});
const { session } = createRelaySession(
  {
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    media: () => undefined,
    readAgentLibrary: async () => ({ definitions: [], identities: [] }),
    query: async (filters) => {
      if (filters.some((filter) => filter.search))
        return [profile(person, { name: "Morgan" })];
      return [
        roster(relay, channelId, members, clock),
        signed(relay, {
          kind: 39000,
          content: "",
          tags: [
            ["d", channelId],
            ["t", "stream"],
            ["private"],
            ["name", "Design"],
          ],
        }),
        profile(viewer, { name: "Carl" }),
        profile(person, { name: "Morgan" }),
      ].filter((event) =>
        filters.some((filter) => matchesEvent(event, filter)),
      );
    },
    writer: {
      kinds: [9000],
      sign: async (template) => signed(viewer, template),
      publish: async () => {
        publishStarted();
        await held;
        members.push(person.pubkey);
        clock++;
      },
    },
  },
  { outboxStorage: { load: () => [], save: () => {} } },
);
session.channels.ensureList();
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
  <ChannelMembersButton session={session} channelId={channelId} />,
);
// The test controls when confirmation arrives; no relay or member is contacted.
Object.assign(window, {
  focusFixture: { published, confirm: () => releasePublish() },
});
