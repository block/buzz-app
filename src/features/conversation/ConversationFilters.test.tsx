// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { ActivityFilters, useActivityView } from "./ConversationList";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function Filters({
  scope,
  layout = "sidebar",
}: {
  scope: string;
  layout?: "sidebar" | "collection";
}) {
  const [view, setView] = useActivityView(scope);
  return (
    <ActivityFilters
      view={view}
      onChange={setView}
      layout={layout}
      agentViews
    />
  );
}

test("Messages controls in the card and page share live filters within their account and community", async () => {
  const user = userEvent.setup();
  render(
    <>
      <section aria-label="Card">
        <Filters scope="viewer-a:community-a" />
      </section>
      <section aria-label="Page">
        <Filters scope="viewer-a:community-a" layout="collection" />
      </section>
      <section aria-label="Other account">
        <Filters scope="viewer-b:community-a" />
      </section>
    </>,
  );
  const card = within(screen.getByRole("region", { name: "Card" }));
  const page = within(screen.getByRole("region", { name: "Page" }));
  await user.click(card.getByRole("tab", { name: "Working" }));
  expect(page.getByRole("tab", { name: "Working" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await user.click(page.getByRole("tab", { name: "Waiting" }));
  expect(card.getByRole("tab", { name: "Waiting" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const menu = page.getByRole("button", {
    name: "Filter and sort conversations",
  });
  await user.click(menu);
  await user.click(
    await screen.findByRole("menuitemradio", { name: "Unread only" }),
  );
  expect(card.getByRole("button", { name: "Showing unread" })).toBeVisible();
  await user.click(menu);
  await user.click(await screen.findByRole("menuitemradio", { name: "A–Z" }));
  await user.click(menu);
  expect(
    await screen.findByRole("menuitemradio", { name: "Unread only" }),
  ).toHaveAttribute("aria-checked", "true");
  expect(screen.getByRole("menuitemradio", { name: "A–Z" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await user.keyboard("{Escape}");
  expect(page.getByRole("tab", { name: "Waiting" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(
    within(screen.getByRole("region", { name: "Other account" })).getByRole(
      "tab",
      { name: "All" },
    ),
  ).toHaveAttribute("aria-selected", "true");
});

test("switching community or account restores its own conversation filters without overwriting them", async () => {
  const user = userEvent.setup();
  const host = render(<Filters scope="viewer-a:community-a" />);
  await user.click(screen.getByRole("tab", { name: "Working" }));
  host.rerender(<Filters scope="viewer-a:community-b" />);
  expect(screen.getByRole("tab", { name: "All" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await user.click(screen.getByRole("tab", { name: "Waiting" }));
  host.rerender(<Filters scope="viewer-b:community-a" />);
  expect(screen.getByRole("tab", { name: "All" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  host.rerender(<Filters scope="viewer-a:community-a" />);
  expect(screen.getByRole("tab", { name: "Working" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  host.rerender(<Filters scope="viewer-a:community-b" />);
  expect(screen.getByRole("tab", { name: "Waiting" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  host.unmount();
  render(<Filters scope="viewer-a:community-a" />);
  expect(screen.getByRole("tab", { name: "Working" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});
