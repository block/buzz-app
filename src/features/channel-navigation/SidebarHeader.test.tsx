// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { Navigation } from "../navigation/controller";
import type { OpenTarget } from "../navigation/targets";
import type {
  RegisteredSidebarHeader,
  SidebarHeader as SidebarHeaderRegistry,
} from "./sidebar-header-service";
import type { SidebarSectionRow } from "./sidebar-sections-service";
import { SidebarHeader } from "./SidebarHeader";

const home: OpenTarget = { version: 1, kind: "home" };
const activity: OpenTarget = {
  version: 1,
  kind: "plugin",
  pluginId: "example.plugin",
};

afterEach(cleanup);

function registryFixture(initial: readonly RegisteredSidebarHeader[]) {
  let entries = initial;
  const listeners = new Set<() => void>();
  const registry: SidebarHeaderRegistry = {
    version: 1,
    snapshot: () => entries,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    register: () => {},
  };
  return {
    registry,
    set(next: readonly RegisteredSidebarHeader[]) {
      entries = next;
      for (const listener of listeners) listener();
    },
  };
}

function entry(
  id: string,
  overrides: Partial<RegisteredSidebarHeader> = {},
): RegisteredSidebarHeader {
  return {
    version: 1,
    id,
    title: `Title ${id}`,
    onTitle: () => {},
    key: `example.plugin/${id}`,
    pluginId: "example.plugin",
    revision: "one",
    ...overrides,
  };
}

function mount(registry: SidebarHeaderRegistry, open = vi.fn()) {
  open.mockResolvedValue({ status: "opened" });
  render(
    <SidebarHeader
      registry={registry}
      navigator={{ open } as unknown as Navigation}
      target={home}
    />,
  );
  return open;
}

it("renders nothing without a header, then the first active header by key", () => {
  const fixture = registryFixture([]);
  mount(fixture.registry);
  expect(screen.queryByRole("button")).toBeNull();

  act(() => fixture.set([entry("zeta"), entry("alpha")]));
  expect(screen.getByRole("button", { name: "Title alpha" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Title zeta" })).toBeNull();
});

it("runs the title action, opens a row's destination and follows live row updates", async () => {
  const onTitle = vi.fn();
  let rows: readonly SidebarSectionRow[] = [
    { id: "threads", label: "Threads" },
  ];
  const listeners = new Set<() => void>();
  const fixture = registryFixture([
    entry("workspace", {
      onTitle,
      rows: {
        snapshot: () => rows,
        subscribe(listener) {
          listeners.add(listener);
          return () => void listeners.delete(listener);
        },
      },
      select: () => activity,
    }),
  ]);
  const open = mount(fixture.registry);
  const user = userEvent.setup();

  await user.click(screen.getByRole("button", { name: "Title workspace" }));
  expect(onTitle).toHaveBeenCalledOnce();
  await user.click(screen.getByRole("button", { name: "Threads" }));
  expect(open).toHaveBeenCalledWith(activity);

  act(() => {
    rows = [...rows, { id: "later", label: "Later", count: 3 }];
    for (const listener of listeners) listener();
  });
  expect(screen.getByRole("button", { name: /Later/ })).toBeVisible();
});

it("reports a rejected title action locally and keeps the header usable", async () => {
  const onTitle = vi.fn().mockRejectedValue(new Error("fixture failed"));
  const fixture = registryFixture([entry("workspace", { onTitle })]);
  mount(fixture.registry);

  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Title workspace" }));
  expect(
    await screen.findByText("This sidebar action couldn’t finish."),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Title workspace" })).toBeVisible();
});

const duplicateRows = [
  { id: "same", label: "A" },
  { id: "same", label: "B" },
];

it("renders nothing when the header's rows are invalid", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const fixture = registryFixture([
    entry("workspace", {
      rows: {
        snapshot: () => duplicateRows,
        subscribe: () => () => {},
      },
      select: () => activity,
    }),
  ]);
  mount(fixture.registry);
  expect(screen.queryByRole("button")).toBeNull();
  expect(console.error).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      message: "Sidebar rows need unique ids and non-empty labels",
    }),
    expect.any(String),
    expect.any(String),
  );
});
