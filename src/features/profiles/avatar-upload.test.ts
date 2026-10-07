// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { encodeAgentSnapshot, type AgentSnapshot } from "../agents/snapshot";
import { pngChunks, snapshotChunk } from "../messages/image-metadata";
import { uploadAvatar } from "./avatar-upload";

const uploadAttachment = vi.fn(async (file: File) => ({
  type: file.type,
  url: "https://relay.example.test/media/avatar.png",
}));
vi.mock("../communities/connection", () => ({
  connectCommunityTransport: async () => ({ uploadAttachment }),
}));

it("strips private snapshot metadata at the avatar upload boundary", async () => {
  const manifest: AgentSnapshot = {
    format: "buzz-agent-snapshot",
    version: 1,
    definition: { name: "Inert", runtime: "buzz-agent" },
    profile: { displayName: "Inert" },
    memory: {
      level: "core",
      entries: [{ slug: "core", body: "INERT_PRIVATE_MEMORY" }],
    },
  };
  const bytes = encodeAgentSnapshot(manifest, "png");
  const file = new File([bytes], "snapshot.agent.png", { type: "image/png" });
  const signal = new AbortController().signal;
  expect(snapshotChunk(pngChunks(bytes))).toBeDefined();
  await uploadAvatar(file, "https://relay.example.test", signal);
  const outgoing = uploadAttachment.mock.calls[0]?.[0];
  expect(outgoing).toBeDefined();
  if (!outgoing) throw new Error("Avatar upload was not attempted");
  const avatarBytes = new Uint8Array(await outgoing.arrayBuffer());
  expect(snapshotChunk(pngChunks(avatarBytes))).toBeUndefined();
  expect(
    pngChunks(avatarBytes).find((chunk) => chunk.kind === "IDAT")?.raw,
  ).toEqual(pngChunks(bytes).find((chunk) => chunk.kind === "IDAT")?.raw);
});
