// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { SidebarRowRenderer } from "./SidebarRowRenderer";
import type { SidebarRow } from "./sidebar-rows-service";

afterEach(cleanup);

it("leaves host output identical with no plugin", () => {
  const Default = (
    <button type="button" aria-current="page">
      Host row
    </button>
  );
  const plain = render(Default);
  const expected = plain.container.innerHTML;
  plain.unmount();
  const row: SidebarRow = {
    id: "row",
    kind: "team",
    label: "Host row",
    sectionKey: "channels",
    channel: { id: "row", name: "Host row" },
    selected: false,
    unread: {
      target: { kind: "channel", channelId: "row" },
      observedCount: null,
      attentionCount: null,
      coverage: "unknown",
      freshness: "unknown",
      manual: "none",
    },
  };
  const mounted = render(
    <SidebarRowRenderer row={row} entries={[]}>
      {Default}
    </SidebarRowRenderer>,
  );
  expect(mounted.container.innerHTML).toBe(expected);
});

it("reports the label of the contribution that hid the row", () => {
  const row: SidebarRow = {
    id: "row",
    kind: "team",
    label: "Row",
    sectionKey: "channels",
    channel: { id: "row", name: "Row" },
    selected: false,
    unread: {
      target: { kind: "channel", channelId: "row" },
      observedCount: null,
      attentionCount: null,
      coverage: "unknown",
      freshness: "unknown",
      manual: "none",
    },
  };
  const entry = (id: string, hide: boolean, hiddenLabel?: string) => ({
    version: 1 as const,
    id,
    key: `p/${id}`,
    pluginId: "p",
    revision: "one",
    ...(hiddenLabel ? { hiddenLabel } : {}),
    render: (_row: SidebarRow, Default: React.ReactElement | null) =>
      hide ? null : Default,
  });
  const calls: [boolean, string | undefined][] = [];
  const onHiddenChange = (_id: string, hidden: boolean, label?: string) => {
    calls.push([hidden, label]);
    return () => {};
  };
  const host = <button type="button">Row</button>;
  const view = render(
    <SidebarRowRenderer
      row={row}
      entries={[entry("first", true, "Muted"), entry("second", true, "Other")]}
      onHiddenChange={onHiddenChange}
    >
      {host}
    </SidebarRowRenderer>,
  );
  view.rerender(
    <SidebarRowRenderer
      row={row}
      entries={[entry("first", false, "Muted"), entry("second", false)]}
      onHiddenChange={onHiddenChange}
    >
      {host}
    </SidebarRowRenderer>,
  );
  expect(calls).toEqual([
    [true, "Muted"],
    [false, undefined],
  ]);
});
