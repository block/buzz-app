import { afterAll, expect, it } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import { keypair, signed } from "../../features/relay/testing";
import type { RelayEvent } from "../../features/relay/events";
import { mergeInboxItems } from "./items";

const viewer = keypair(),
  author = keypair();
const repo = `30617:${author.pubkey}:repo`;
const owner = createRelaySession({
  viewer: viewer.pubkey,
  relayAuthor: author.pubkey,
  query: async () => [],
  media: () => undefined,
});
afterAll(() => owner.dispose());
const event = (kind: number, at: number, tags: string[][] = []) =>
  signed(author, {
    kind,
    created_at: at,
    tags: [["a", repo], ["p", viewer.pubkey], ...tags],
    content: `activity ${at}`,
  });
const rows = (...events: RelayEvent[]) =>
  mergeInboxItems(
    [],
    {
      status: "ready",
      mentions: events,
      needsAction: [],
      limited: false,
    },
    [],
    owner.session,
  );

it("uses the actual admitted issue/PR root kind for newer status and marked comments", () => {
  for (const [kind, type] of [
    [1621, "issue"],
    [1618, "pr"],
  ] as const) {
    const root = event(kind, 1);
    for (const updateKind of [1630, 1631, 1632, 1633, 1]) {
      const update = event(updateKind, 2, [
        ["e", "a".repeat(64), "", "reply"],
        ["e", root.id, "", "root"],
      ]);
      const result = rows(root, update);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        preview: "activity 2",
        project: { type, owner: author.pubkey, dtag: "repo", id: root.id },
      });
    }
  }
});
it("unknown, ambiguous or wrong-repository roots route honestly to the repository", () => {
  const missing = event(1, 2, [["E", "a".repeat(64)]]);
  const wrongRepo = signed(author, {
    kind: 1621,
    created_at: 1,
    tags: [["a", `30617:${author.pubkey}:elsewhere`]],
    content: "other issue",
  });
  const wrong = event(1631, 3, [["e", wrongRepo.id, "", "root"]]);
  const ambiguous = event(1632, 4, [
    ["e", missing.id, "", "root"],
    ["e", wrongRepo.id, "", "root"],
  ]);
  for (const update of [missing, wrong, ambiguous]) {
    const row = rows(wrongRepo, update).find(
      (row) => row.latestMessageId === update.id,
    );
    expect(row?.project).toEqual({
      type: "repo",
      owner: author.pubkey,
      dtag: "repo",
    });
  }
});
