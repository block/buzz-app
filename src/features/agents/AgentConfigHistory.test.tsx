// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RelayEvent } from "../relay/events";
import { ARTIFACT_KIND, type SnapshotRead } from "./agent-config-artifacts";
import { AgentConfigHistory } from "./AgentConfigHistory";
import { HISTORY_PAGE } from "./agent-config-history";

afterEach(cleanup);
const channel = "9b353519-f4fe-4757-aef4-bec6cc0ae54c";
const d = "5b1d3b52-6c4e-5a0b-8e3c-1f2a3b4c5d6e";
const expected = { channel, d, type: "buzz.agent.instructions" as const };
const rev = (id: string, prev: string | undefined, text: string): RelayEvent =>
  ({
    id,
    pubkey: "a".repeat(64),
    sig: "b".repeat(128),
    kind: ARTIFACT_KIND,
    created_at: 1_700_000_000,
    content: JSON.stringify({ version: 1, text }),
    tags: [
      ["ar", "1"],
      ["d", d],
      ["h", channel],
      ["type", "buzz.agent.instructions"],
      ["title", "Agent instructions"],
      ["op", prev ? "update" : "create"],
      ...(prev ? [["prev", prev]] : []),
    ],
  }) as RelayEvent;

it("pages older history, labels the gap, shows a diff and reverts on the head", async () => {
  // Newest first: r(n-1) … r0; one revision beyond the first page.
  const revisions = Array.from({ length: HISTORY_PAGE + 1 }, (_, i) =>
    rev(`r${i}`, i ? `r${i - 1}` : undefined, `line ${i}`),
  ).reverse();
  let fail = false;
  const read: SnapshotRead = async ([filter]) => {
    if (fail) throw new Error("offline");
    const offset = filter?.offset ?? 0;
    return revisions.slice(offset, offset + (filter?.limit ?? 0));
  };
  const head = revisions[0] as RelayEvent;
  const onRevert = vi.fn(async () => {});
  render(
    <AgentConfigHistory
      expected={expected}
      head={head}
      read={read}
      onRevert={onRevert}
    />,
  );

  expect(
    await screen.findByText("Older revisions aren't loaded yet."),
  ).toBeInTheDocument();
  fail = true;
  fireEvent.click(screen.getByText("Load older"));
  expect(
    await screen.findByText("Couldn't load older revisions."),
  ).toBeInTheDocument();
  fail = false;
  fireEvent.click(screen.getByText("Retry"));
  expect(await screen.findAllByText(/^create/)).toHaveLength(1);
  expect(screen.queryByText(/aren't loaded|Couldn't load/)).toBeNull();

  const [first] = screen.getAllByText("Show changes");
  fireEvent.click(first as HTMLElement);
  const diff = screen.getByRole("region", { name: "Changes" });
  expect(diff).toHaveTextContent(`− line ${HISTORY_PAGE - 1}`);
  expect(diff).toHaveTextContent(`+ line ${HISTORY_PAGE}`);

  const reverts = screen.getAllByText("Revert to this");
  expect(reverts).toHaveLength(HISTORY_PAGE);
  fireEvent.click(reverts[0] as HTMLElement);
  expect(onRevert).toHaveBeenCalledOnce();
  const [template] = onRevert.mock.calls[0] as unknown as [
    { content: string; tags: string[][] },
  ];
  expect(template.content).toBe(revisions[1]?.content);
  expect(template.tags).toContainEqual(["op", "update"]);
  expect(template.tags).toContainEqual(["prev", head.id]);
});

it("labels a predecessor missing from complete history unavailable", async () => {
  const read: SnapshotRead = async () => [
    rev("r2", "r1", "b"),
    rev("r0", undefined, "a"),
  ];
  render(
    <AgentConfigHistory
      expected={expected}
      head={undefined}
      read={read}
      onRevert={async () => {}}
    />,
  );
  expect(
    await screen.findByText(
      "A revision here isn't available (removed or expired).",
    ),
  ).toBeInTheDocument();
  expect(screen.getAllByRole("list")).toHaveLength(2);
  expect(screen.queryByRole("button", { name: "Revert to this" })).toBeNull();
});
