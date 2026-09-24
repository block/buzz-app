// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it } from "vitest";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelayEvent } from "../../features/relay/events";
import { keypair, signed } from "../../features/relay/testing";
import { createWorkflows } from "../../features/workflows/capability";
import { WorkflowLanding } from "./WorkflowLanding";
import { fixtureDefinition, fixtureViewer, fixtureYaml } from "./fixtures";

afterEach(cleanup);
const channel = (index: number): ChannelSummary => ({
  id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  name: `Channel ${index}`,
  channelType: index % 2 ? "stream" : "dm",
});
const author = keypair();
function event(id: string): RelayEvent {
  return signed(author, {
    created_at: 123,
    kind: 30620,
    tags: [
      ["h", id],
      ["d", fixtureDefinition.id],
    ],
    content: fixtureYaml,
  });
}
function mount(initial = [channel(1), channel(2), channel(3)]) {
  let channels = initial;
  const reads: {
    id: string;
    signal: AbortSignal | undefined;
    resolve(events: readonly RelayEvent[]): void;
    reject(error: Error): void;
  }[] = [];
  const owner = createWorkflows({
    viewer: fixtureViewer,
    outbox: undefined,
    local: undefined,
    host: undefined,
    canAccess: (id) => channels.some((item) => item.id === id),
    reader: {
      read(filters, options) {
        return new Promise((resolve, reject) => {
          reads.push({
            id: filters[0]?.["#h"]?.[0] ?? "",
            signal: options?.signal,
            resolve,
            reject,
          });
        });
      },
    },
  });
  let refresh = 0;
  const element = () => (
    <StrictMode>
      <WorkflowLanding
        capability={owner.capability}
        channels={channels}
        refreshRequest={refresh}
        viewer={fixtureViewer}
        onCreate={() => {}}
        onOpen={() => {}}
      />
    </StrictMode>
  );
  const rendered = render(element());
  return {
    owner,
    reads,
    change(next: ChannelSummary[], revoke = false) {
      channels = next;
      act(() => {
        if (revoke) owner.clear();
        rendered.rerender(element());
      });
    },
    refresh() {
      refresh++;
      rendered.rerender(element());
    },
    async finish(index: number, events: readonly RelayEvent[] = []) {
      await waitFor(() => expect(reads.length).toBeGreaterThan(index));
      await act(async () => {
        reads[index]?.resolve(events);
      });
    },
    close() {
      rendered.unmount();
      owner.dispose();
      for (const read of reads) read.resolve([]);
    },
  };
}

it("keeps one stable status for a large mixed roster and never rereads on metadata reorder", async () => {
  const channels = Array.from({ length: 24 }, (_, i) => channel(i + 1));
  const fixture = mount(channels);
  try {
    await waitFor(() => expect(fixture.reads).toHaveLength(1));
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent("Reading workflows…");
    fixture.change(
      [...channels].reverse().map((c) => ({ ...c, name: `Renamed ${c.name}` })),
    );
    for (let i = 0; i < channels.length; i++) {
      await fixture.finish(i);
      expect(screen.getAllByRole("status")).toHaveLength(1);
    }
    expect(screen.getByRole("status")).toHaveTextContent(
      "Workflow discovery complete.",
    );
    expect(fixture.reads.map((r) => r.id)).toEqual(channels.map((c) => c.id));
    fixture.change(channels);
    expect(fixture.reads).toHaveLength(24);
  } finally {
    fixture.close();
  }
});

it("adds only new IDs, cancels removed reads, ignores late completion, and refreshes deliberately", async () => {
  const a = channel(1),
    b = channel(2),
    c = channel(3),
    d = channel(4);
  const fixture = mount([a, b]);
  try {
    await fixture.finish(0, [event(a.id)]);
    await waitFor(() => expect(fixture.reads).toHaveLength(2));
    fixture.change([c, a, b]);
    fixture.change([a, c, d]);
    await waitFor(() => expect(fixture.reads).toHaveLength(3));
    expect(fixture.reads[1]?.signal?.aborted).toBe(true);
    await fixture.finish(1, [event(b.id)]);
    await fixture.finish(2);
    await fixture.finish(3);
    expect(
      screen.getAllByRole("button", { name: "Open Message helper" }),
    ).toHaveLength(1);
    expect(fixture.reads.map((r) => r.id)).toEqual([a.id, b.id, c.id, d.id]);
    fixture.refresh();
    for (let i = 4; i < 7; i++) await fixture.finish(i);
    expect(fixture.reads.map((r) => r.id)).toEqual([
      a.id,
      b.id,
      c.id,
      d.id,
      a.id,
      c.id,
      d.id,
    ]);
    expect(
      screen.queryByRole("button", { name: "Open Message helper" }),
    ).toBeNull();
  } finally {
    fixture.close();
  }
});

it("purges globally without automatic reads and recovers remaining channels on membership removal", async () => {
  const a = channel(1),
    b = channel(2),
    c = channel(3);
  const fixture = mount([a, b, c]);
  try {
    await fixture.finish(0, [event(a.id)]);
    await fixture.finish(1, [event(b.id)]);
    await waitFor(() => expect(fixture.reads).toHaveLength(3));
    fixture.change([a, c], true);
    expect(
      screen.queryByRole("button", { name: "Open Message helper" }),
    ).toBeNull();
    expect(fixture.reads[2]?.signal?.aborted).toBe(true);
    await fixture.finish(2, [event(c.id)]);
    await fixture.finish(3, [event(a.id)]);
    await fixture.finish(4);
    expect(fixture.reads.map((r) => r.id)).toEqual([
      a.id,
      b.id,
      c.id,
      a.id,
      c.id,
    ]);
    act(() => fixture.owner.clear());
    expect(
      screen.queryByRole("button", { name: "Open Message helper" }),
    ).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(
      "cleared or unavailable",
    );
    fixture.change([c, a]);
    expect(fixture.reads).toHaveLength(5);
    fixture.refresh();
    await fixture.finish(5);
    await fixture.finish(6);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Workflow discovery complete.",
    );
  } finally {
    fixture.close();
  }
});

it("preserves partial results, exposes failures, and retries without dropping loaded cards", async () => {
  const a = channel(1),
    b = channel(2);
  const fixture = mount([a, b]);
  try {
    await fixture.finish(
      0,
      Array.from({ length: 100 }, () => event(a.id)),
    );
    expect(
      screen.getByText("#Channel 1 returned a partial workflow list."),
    ).toBeVisible();
    await waitFor(() => expect(fixture.reads).toHaveLength(2));
    await act(async () => fixture.reads[1]?.reject(new Error("offline")));
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(fixture.reads).toHaveLength(3));
    expect(
      screen.getByRole("button", { name: "Open Message helper" }),
    ).toBeVisible();
    await fixture.finish(2, [event(a.id)]);
    await fixture.finish(3);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  } finally {
    fixture.close();
  }
});

it("stops queued reads on interruption, retains settled cards and resumes only on refresh", async () => {
  const a = channel(1),
    b = channel(2),
    c = channel(3);
  const fixture = mount([a, b, c]);
  try {
    await fixture.finish(0, [event(a.id)]);
    await waitFor(() => expect(fixture.reads).toHaveLength(2));
    act(() => fixture.owner.interrupt());
    await fixture.finish(1, [event(b.id)]);
    expect(fixture.reads[1]?.signal?.aborted).toBe(true);
    expect(fixture.reads).toHaveLength(2);
    expect(
      screen.getAllByRole("button", { name: "Open Message helper" }),
    ).toHaveLength(1);
    expect(screen.queryByText("Reading workflows…")).toBeNull();
    fixture.refresh();
    for (let i = 2; i < 5; i++) await fixture.finish(i);
    expect(fixture.reads.map((r) => r.id)).toEqual([
      a.id,
      b.id,
      a.id,
      b.id,
      c.id,
    ]);
  } finally {
    fixture.close();
  }
});

it("keeps session purge coverage after removing the last completed observer without rereading", async () => {
  const a = channel(1),
    b = channel(2);
  const fixture = mount([a, b]);
  try {
    await fixture.finish(0, [event(a.id)]);
    await fixture.finish(1);
    fixture.change([a]);
    act(() => fixture.owner.clear());
    expect(
      screen.queryByRole("button", { name: "Open Message helper" }),
    ).toBeNull();
    expect(fixture.reads).toHaveLength(2);
    fixture.refresh();
    await fixture.finish(2, [event(a.id)]);
    expect(
      screen.getByRole("button", { name: "Open Message helper" }),
    ).toBeVisible();
  } finally {
    fixture.close();
  }
});

it("retains the same channel's loaded cards when its refresh fails", async () => {
  const a = channel(1);
  const fixture = mount([a]);
  try {
    await fixture.finish(0, [event(a.id)]);
    fixture.refresh();
    await waitFor(() => expect(fixture.reads).toHaveLength(2));
    await act(async () => fixture.reads[1]?.reject(new Error("offline")));
    expect(
      screen.getByRole("button", { name: "Open Message helper" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
    fixture.refresh();
    await fixture.finish(2);
    expect(
      screen.queryByRole("button", { name: "Open Message helper" }),
    ).toBeNull();
  } finally {
    fixture.close();
  }
});

it("does not reread recovered channels when a membership is added after explicit recovery", async () => {
  const a = channel(1),
    b = channel(2);
  const fixture = mount([a]);
  try {
    await fixture.finish(0);
    act(() => fixture.owner.clear());
    fixture.refresh();
    await fixture.finish(1);
    fixture.change([a, b]);
    await fixture.finish(2);
    expect(fixture.reads.map((read) => read.id)).toEqual([a.id, a.id, b.id]);
  } finally {
    fixture.close();
  }
});
