import { Context } from "@deepseek-ai/cordis";
import { createCommunities } from "../../src/features/communities/service";
import { ArtifactStorageService } from "../../src/features/artifact-storage/service";
import { createArtifactStore } from "../../src/features/artifact-storage/store";
import type { ArtifactCollectionDefinition } from "../../src/features/artifact-storage/types";

const viewer = "a".repeat(64);
const membership = { id: "https://fixture.example", name: "Fixture" };
const profile = { name: "Fixture", picture: "" };
const root = new Context();
const communities = createCommunities(
  root,
  false,
  undefined,
  "",
  undefined,
  Promise.resolve(viewer),
);
root.provide("communityReader", communities);
const storage = new ArtifactStorageService(root);
const plugin = root.extend({
  pluginOwner: { id: "test.plugin", revision: "one" },
});
const definition: ArtifactCollectionDefinition = {
  name: "tasks",
  type: "test.task",
  version: 1,
  project: () => [],
};
let signal: AbortSignal | undefined;
storage.onOpen((entry) => {
  signal = entry.signal;
});
const api = {
  snapshot: communities.snapshot,
  join: () => communities.joined(membership, profile),
  async syncJoin() {
    await communities.applySync({ known: [], outbox: [] }, [membership.id]);
    communities.select(membership.id);
  },
  leave: (purge: boolean) => communities.leave(membership.id, { purge }),
  open: () => plugin.artifactStorage.open(definition),
  aborted: () => signal?.aborted,
  async saved() {
    const store = createArtifactStore(viewer, membership.id);
    try {
      return await store.collection("test.plugin", definition).get("task");
    } finally {
      store.close();
    }
  },
};
declare global {
  interface Window {
    communityArtifacts: typeof api;
  }
}
window.communityArtifacts = api;
