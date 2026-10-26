import { expect, it, vi } from "vitest";
import type { EventData } from "../relay/events";
import {
  catalogContent,
  catalogHead,
  isShared,
  publishShare,
  readSnapshot,
  shareable,
  snapshotJson,
} from "./agent-share";
import { validCatalogEnvelope } from "./catalog-envelope";
import type { Agent, RegisteredAgentType } from "./service";
import { sharedAgents } from "./shared-agents";

const owner = "f".repeat(64);
const pubkey = "a".repeat(64);
const agent = (config: Record<string, unknown>, picture?: string): Agent => ({
  key: pubkey,
  pubkey,
  name: "Ada",
  ...(picture ? { picture } : {}),
  type: "test/echo",
  owner,
  relay: "wss://relay.example",
  place: "here",
  config,
  attention: {},
  skipped: {},
  timers: {},
  attentionEnabled: true,
});
type Saved = { instructions: string; model: string; workspace: string };
const echo = {
  key: "test/echo",
  title: "Echo",
  carry: (saved: Saved) => ({
    instructions: saved.instructions,
    workspace: saved.workspace,
  }),
  exportShared: (saved: Saved) => ({
    runtime: "echo",
    provider: "acme",
    model: saved.model,
  }),
} as unknown as RegisteredAgentType;
const saved = {
  instructions: "Review pull requests.",
  model: "echo-1",
  workspace: "/Users/ada/private",
  apiKey: "sk-not-in-any-export-000000",
};

it("shares only its name, instructions, runtime and model, never its workspace or other settings", () => {
  const definition = shareable(
    agent(saved, "https://media.example/ada.png"),
    echo,
  );
  expect(definition).toEqual({
    name: "Ada",
    picture: "https://media.example/ada.png",
    instructions: "Review pull requests.",
    runtime: "echo",
    provider: "acme",
    model: "echo-1",
  });
  for (const text of [catalogContent(definition), snapshotJson(definition)]) {
    expect(text).not.toContain("/Users/ada");
    expect(text).not.toContain("sk-not");
    expect(text).not.toContain(pubkey);
  }
});

it("refuses a type that cannot share and instructions that look like a credential", () => {
  expect(() =>
    shareable(agent(saved), {
      ...echo,
      exportShared: undefined,
    } as unknown as RegisteredAgentType),
  ).toThrow(
    "Agent 'Ada' uses a runtime that cannot be shared with the community catalog.",
  );
  expect(() =>
    shareable(
      agent({ ...saved, instructions: "Use api_key=abcdef0123456789." }),
      echo,
    ),
  ).toThrow(
    "Portable configuration appears to contain a credential. Remove it before export.",
  );
});

it("leaves out a picture that is not an HTTPS URL", () => {
  expect(
    shareable(agent(saved, "data:image/png;base64,AAAA"), echo),
  ).not.toHaveProperty("picture");
});

it("leaves out a picture whose query or fragment could carry a token", () => {
  for (const picture of [
    "https://images.example/avatar.png?access_token=syntheticcredential123",
    "https://images.example/avatar.png#access_token=syntheticcredential123",
  ]) {
    const definition = shareable(agent(saved, picture), echo);
    expect(definition).not.toHaveProperty("picture");
    for (const text of [catalogContent(definition), snapshotJson(definition)])
      expect(text).not.toContain("syntheticcredential123");
  }
  expect(() =>
    shareable(
      agent(saved, "https://images.example/api_key=syntheticcredential123.png"),
      echo,
    ),
  ).toThrow(
    "Portable configuration appears to contain a credential. Remove it before export.",
  );
});

it("publishes a catalog entry the marketplace lists as it was shared", () => {
  const content = catalogContent(shareable(agent(saved), echo));
  const event: EventData = {
    id: "1".repeat(64),
    pubkey: owner,
    created_at: 10,
    kind: 30175,
    tags: [
      ["d", pubkey],
      ["shared", "true"],
    ],
    content,
  };
  expect(validCatalogEnvelope(event)).toBe(true);
  expect(sharedAgents([event])).toEqual([
    {
      id: `${owner}:${pubkey}`,
      name: "Ada",
      owner,
      model: "echo-1",
      runtime: "echo",
      provider: "acme",
      instructions: "Review pull requests.",
    },
  ]);
});

it("reads back what it exports", async () => {
  const definition = shareable(
    agent(saved, "https://media.example/ada.png"),
    echo,
  );
  expect(await readSnapshot(new Blob([snapshotJson(definition)]))).toEqual(
    definition,
  );
});

/** A PNG holding `text` in a tEXt chunk, as block/buzz writes `.agent.png`. */
function png(text: string) {
  const chunk = (kind: string, data: Uint8Array) => {
    const bytes = new Uint8Array(12 + data.length);
    new DataView(bytes.buffer).setUint32(0, data.length);
    bytes.set(new TextEncoder().encode(kind), 4);
    bytes.set(data, 8);
    return bytes;
  };
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", new Uint8Array(13)),
    chunk("tEXt", new TextEncoder().encode(text)),
    chunk("IEND", new Uint8Array()),
  ];
  const bytes = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
}

it("imports a block/buzz snapshot, leaving behind what an agent here has no place for", async () => {
  const manifest = JSON.stringify({
    format: "buzz-agent-snapshot",
    version: 1,
    definition: {
      name: "Scout",
      sourceIsBuiltin: false,
      systemPrompt: "Scout ahead.",
      runtime: "goose",
      model: "claude-opus",
      provider: "anthropic",
      respondTo: "owner-only",
      parallelism: 2,
      namePool: [],
    },
    profile: {
      displayName: "Scout",
      avatarDataUrl: "data:image/png;base64,AAAA",
      avatarUrl: "https://media.example/scout.png",
    },
    memory: { level: "core", entries: [{ slug: "core", body: "secret" }] },
  });
  const expected = {
    name: "Scout",
    picture: "https://media.example/scout.png",
    instructions: "Scout ahead.",
    runtime: "goose",
    provider: "anthropic",
    model: "claude-opus",
  };
  expect(await readSnapshot(new Blob([manifest]))).toEqual(expected);
  expect(
    await readSnapshot(
      new Blob([png(`buzz_agent_snapshot\0${btoa(manifest)}`)]),
    ),
  ).toEqual(expected);
});

it("rejects files that are not agent snapshots", async () => {
  const read = (value: unknown) =>
    readSnapshot(new Blob([JSON.stringify(value)]));
  await expect(readSnapshot(new Blob(["{"]))).rejects.toThrow(
    "Invalid snapshot JSON.",
  );
  await expect(
    read({ format: "buzz-team-snapshot", version: 1 }),
  ).rejects.toThrow("Unsupported snapshot format.");
  await expect(
    read({ format: "buzz-agent-snapshot", version: 2 }),
  ).rejects.toThrow("Unsupported snapshot version.");
  await expect(
    read({ format: "buzz-agent-snapshot", version: 1, definition: {} }),
  ).rejects.toThrow("Display name is required");
  await expect(readSnapshot(new Blob([png("Comment\0hello")]))).rejects.toThrow(
    "PNG does not contain a buzz_agent_snapshot tEXt chunk.",
  );
  await expect(
    readSnapshot(new Blob([png("buzz_agent_snapshot\0%%%")])),
  ).rejects.toThrow("Invalid PNG snapshot.");
});

it("refuses an oversized file without reading it in", async () => {
  const huge = (start: BlobPart) =>
    ({
      size: 10 * 1024 * 1024 + 1,
      slice: () => new Blob([start]),
      arrayBuffer: () => {
        throw new Error("read the whole file");
      },
    }) as unknown as Blob;
  await expect(readSnapshot(huge("{"))).rejects.toThrow(
    "Snapshot exceeds the size limit.",
  );
  await expect(readSnapshot(huge(png("")))).rejects.toThrow(
    "Snapshot exceeds the size limit.",
  );
});

it("reads the owner's newest head and replaces it, shared or not", async () => {
  const head = (created_at: number, shared: boolean): EventData => ({
    id: String(created_at).repeat(64).slice(0, 64),
    pubkey: owner,
    created_at,
    kind: 30175,
    tags: [["d", pubkey], ...(shared ? [["shared", "true"]] : [])],
    content: "{}",
  });
  const read = vi.fn(async () => [
    head(1, true),
    head(2, false),
    { ...head(3, true), pubkey: "e".repeat(64) },
  ]);
  const signal = new AbortController().signal;
  const newest = await catalogHead({ read }, owner, pubkey, signal);
  expect(read).toHaveBeenCalledWith(
    [
      {
        kinds: [30175],
        authors: [owner],
        "#d": [pubkey],
        limit: 10,
        consistency: "strong",
      },
    ],
    { signal, fresh: true },
  );
  expect(newest?.created_at).toBe(2);
  expect(isShared(newest)).toBe(false);

  let delivery = "sending";
  const listeners = new Set<() => void>();
  const outbox = {
    supports: (kind: number) => kind === 30175,
    ready: async () => {},
    send: vi.fn(() => "sent"),
    snapshot: () => [{ event: { id: "sent" }, delivery }],
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dismiss: vi.fn(async () => {}),
  };
  const published = publishShare(
    { outbox } as never,
    pubkey,
    "{}",
    true,
    newest,
    signal,
  );
  await vi.waitFor(() => expect(outbox.send).toHaveBeenCalled());
  expect(outbox.send).toHaveBeenCalledWith(
    {
      kind: 30175,
      content: "{}",
      tags: [
        ["d", pubkey],
        ["shared", "true"],
      ],
      supersedes: 2,
    },
    undefined,
    expect.any(Function),
  );
  delivery = "accepted";
  for (const listener of listeners) listener();
  // The accepted event is the new head.
  expect(await published).toEqual({ id: "sent" });
  expect(outbox.dismiss).toHaveBeenCalledWith("sent");
  await expect(
    publishShare(
      { outbox: { ...outbox, supports: () => false } } as never,
      pubkey,
      "{}",
      false,
      undefined,
      signal,
    ),
  ).rejects.toThrow("This community cannot update catalog sharing.");
});
