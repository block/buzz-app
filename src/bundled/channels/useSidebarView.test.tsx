// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readView, writeView } from "../../shared/view-state";
import { useSidebarView } from "./useSidebarView";

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
const group = "session-children:general";
function Harness({ scope = "community/viewer" }: { scope?: string }) {
  const sidebar = useSidebarView(scope, true);
  return (
    <nav ref={sidebar.list}>
      <input
        aria-label="Search"
        value={sidebar.search}
        onChange={(event) => sidebar.setSearch(event.target.value)}
      />
      {["channels", "starred", group, "session-children:other"].map((key) => (
        <button
          key={key}
          type="button"
          aria-label={key}
          aria-expanded={!sidebar.isCollapsed(key)}
          onClick={() => {
            if (!sidebar.search) sidebar.toggle(key, sidebar.isCollapsed(key));
          }}
        />
      ))}
      <button type="button" onClick={() => sidebar.toggle(group, true)}>
        New private session
      </button>
    </nav>
  );
}
function mount(scope?: string) {
  return render(<Harness {...(scope ? { scope } : {})} />, {
    reactStrictMode: true,
  });
}
const button = (name = group) => screen.getByRole("button", { name });
const saved = () => readView("community/viewer", "channel-sidebar", {});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

it("defaults only session children closed and leaves categories open", () => {
  mount();
  expect(button()).toHaveAttribute("aria-expanded", "false");
  expect(button("session-children:other")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  expect(button("channels")).toHaveAttribute("aria-expanded", "true");
  expect(button("starred")).toHaveAttribute("aria-expanded", "true");
});

it("persists positive expansion and explicit collapse across same-scope remounts, not other scopes", async () => {
  const user = userEvent.setup();
  let view = mount();
  await user.click(button());
  await user.click(button("starred"));
  view.unmount();
  expect(saved()).toMatchObject({ expanded: [group], collapsed: ["starred"] });
  view = mount();
  expect(button()).toHaveAttribute("aria-expanded", "true");
  expect(button("starred")).toHaveAttribute("aria-expanded", "false");
  await user.click(button());
  view.unmount();
  expect(saved()).toMatchObject({
    expanded: [],
    collapsed: ["starred", group],
  });
  view = mount();
  expect(button()).toHaveAttribute("aria-expanded", "false");
  view.unmount();
  mount("another-community/viewer");
  expect(button()).toHaveAttribute("aria-expanded", "false");
  expect(button("starred")).toHaveAttribute("aria-expanded", "true");
});

it.each([
  { collapsed: [group, "starred"] },
  { collapsed: [group, "starred"], expanded: [group] },
  {
    collapsed: [false, "starred"],
    expanded: [
      null,
      1,
      {},
      "channels",
      "session-children:",
      "session-children: general",
    ],
  },
  { collapsed: ["starred"], expanded: "session-children:general" },
])("restores legacy/invalid expansion conservatively: %j", (value) => {
  writeView("community/viewer", "channel-sidebar", value);
  mount();
  expect(button()).toHaveAttribute("aria-expanded", "false");
  expect(button("channels")).toHaveAttribute("aria-expanded", "true");
  expect(button("starred")).toHaveAttribute("aria-expanded", "false");
});

it("search expansion is temporary and neither changes nor allows toggling saved choices", async () => {
  const user = userEvent.setup();
  const view = mount();
  await user.click(button("session-children:other"));
  await user.click(button("starred"));
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "general" },
  });
  expect(button()).toHaveAttribute("aria-expanded", "true");
  expect(button("starred")).toHaveAttribute("aria-expanded", "true");
  await user.click(button());
  fireEvent(window, new Event("pagehide"));
  expect(saved()).toMatchObject({
    expanded: ["session-children:other"],
    collapsed: ["starred"],
  });
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
  expect(button()).toHaveAttribute("aria-expanded", "false");
  expect(button("session-children:other")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  expect(button("starred")).toHaveAttribute("aria-expanded", "false");
  view.unmount();
  mount();
  expect(button()).toHaveAttribute("aria-expanded", "false");
});

it.each([{ collapsed: [] }, { collapsed: [group] }])(
  "explicit private-session start opens a default or saved closed group: %j",
  async ({ collapsed }) => {
    writeView("community/viewer", "channel-sidebar", { collapsed });
    const view = mount();
    await userEvent.setup().click(button("New private session"));
    expect(button()).toHaveAttribute("aria-expanded", "true");
    view.unmount();
    mount();
    expect(button()).toHaveAttribute("aria-expanded", "true");
  },
);
