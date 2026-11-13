import { expect, it, vi } from "vitest";
import type { ReadFilter } from "../../features/relay/events";
import { keypair } from "../../features/relay/testing";
import type { RelaySession } from "../../features/relay/session";
import { confirmReviewAgents, reviewChannel } from "./access";
import {
  loadConfigurations,
  loadRepositoryDirectory,
  saveConfiguration,
  type ReviewConfig,
} from "./configuration";
import { reviewAgentProfile, reviewTestAccess } from "./testing";

const channel = "11111111-1111-4111-8111-111111111111";

function fixture() {
  const viewer = keypair(),
    owner = keypair(),
    agent = keypair();
  const access = reviewTestAccess(viewer.pubkey, channel, [
    owner.pubkey,
    agent.pubkey,
  ]);
  const list = access.channels.list();
  const profile = reviewAgentProfile(owner, agent);
  const session = {
    ...access,
    snapshotRead: vi.fn(async () => [profile]),
  } as unknown as RelaySession;
  return { session, list, viewer, owner, agent, profile };
}

it("rejects public previews, nonmembership and stale membership before reading configurations", async () => {
  for (const patch of [
    { visibility: "public" as const },
    { members: [] },
    { cached: true as const },
    { metadataCached: true as const },
  ]) {
    const f = fixture();
    f.list.channels[0] = {
      ...f.list.channels[0],
      id: channel,
      name: "Reviews",
      ...patch,
    };
    await expect(
      loadConfigurations(f.session, channel, new AbortController().signal),
    ).rejects.toThrow("membership");
    expect(f.session.snapshotRead).not.toHaveBeenCalled();
  }
});

it("accepts another member's attested agent and fences owner or reviewer removal before delivery", async () => {
  for (const remove of ["owner", "agent"] as const) {
    const f = fixture();
    const check = await confirmReviewAgents(
      f.session,
      channel,
      [f.agent.pubkey],
      new AbortController().signal,
      true,
    );
    check();
    f.list.channels[0] = {
      ...f.list.channels[0],
      id: channel,
      name: "Reviews",
      members: [
        f.viewer.pubkey,
        f[remove === "owner" ? "agent" : "owner"].pubkey,
      ],
    };
    expect(check).toThrow(
      remove === "owner" ? "ownership" : "reviewer must also belong",
    );
    expect(() => reviewChannel(f.session, channel, true)).not.toThrow();
  }
});

it("uses strong roster confirmation and rejects a removed owner before saving", async () => {
  const f = fixture();
  const refresh = vi.fn(async () => {
    f.list.channels[0] = {
      ...f.list.channels[0],
      id: channel,
      name: "Reviews",
      members: [f.viewer.pubkey, f.agent.pubkey],
    };
    return true;
  });
  const session = {
    ...f.session,
    channels: { ...f.session.channels, refreshRoster: refresh },
  };
  await expect(
    confirmReviewAgents(
      session,
      channel,
      [f.agent.pubkey],
      new AbortController().signal,
    ),
  ).rejects.toThrow("ownership");
  expect(refresh).toHaveBeenCalledWith(
    channel,
    expect.objectContaining({ consistency: "strong" }),
  );
});

it("does not publish a configuration if an agent owner leaves while it is signing", async () => {
  const f = fixture();
  const publish = vi.fn();
  const sign = vi.fn(async () => {
    f.list.channels[0] = {
      ...f.list.channels[0],
      id: channel,
      name: "Reviews",
      members: [f.viewer.pubkey, f.agent.pubkey],
    };
    return f.profile;
  });
  const draft: ReviewConfig = {
    version: 1,
    repository: "example-org/project",
    reminderMinutes: 15,
    lanes: [
      {
        id: "general",
        name: "General",
        instructions: "Review",
        reviewers: [f.agent.pubkey],
        routing: {
          mode: "all",
          rules: [
            { id: "r", field: "files", operator: "at-least", value: "0" },
          ],
        },
      },
    ],
  };
  const session = {
    ...f.session,
    configArtifactWriter: { sign, publish },
  } as RelaySession;
  await expect(
    saveConfiguration(
      session,
      channel,
      draft,
      undefined,
      new AbortController().signal,
    ),
  ).rejects.toThrow("ownership");
  expect(sign).toHaveBeenCalledOnce();
  expect(publish).not.toHaveBeenCalled();
});

it("batches large channel sets within relay predicate limits", async () => {
  const f = fixture();
  const channels = Array.from(
    { length: 300 },
    (_, index) => `channel-${index}`,
  );
  f.list.channels = channels.map((id) => ({
    ...f.list.channels[0],
    name: "Reviews",
    id,
  }));
  const read = vi.fn(async (filters: readonly ReadFilter[]) => {
    expect(filters[0]?.limit).toBeLessThanOrEqual(500);
    return [];
  });
  const session = { ...f.session, snapshotRead: read };
  expect(
    await loadRepositoryDirectory(
      session,
      channels,
      new AbortController().signal,
    ),
  ).toEqual({ rows: [], incomplete: false });
  expect(read).toHaveBeenCalledTimes(2);
  expect(read.mock.calls.map((call) => call[0][0]?.["#h"]?.length)).toEqual([
    255, 45,
  ]);
});
