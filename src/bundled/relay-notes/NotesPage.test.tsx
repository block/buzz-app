// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { useRef, useState } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { noteKey, noteUrl } from "../../features/notes/model";
import { notesFixture } from "../../features/notes/testing";
import { NotesPage, type NotesPageProps } from "./NotesPage";

const dispose: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const stop of dispose.splice(0)) stop();
});
async function fixture() {
  const f = await notesFixture();
  dispose.push(f.dispose);
  const first = f.seed("First page", "Earlier findings");
  const latest = f.seed("Latest page", "Searchable body");
  const props: NotesPageProps = {
    community: f.origin,
    entries: [first, latest],
    items: [],
    selected: "browse",
    query: "",
    trash: false,
    canFilter: true,
    searchRef: { current: null },
    loading: false,
    more: false,
    error: "",
    search: vi.fn(),
    showDeleted: vi.fn(),
    create: vi.fn(),
    refresh: vi.fn(),
    loadMore: vi.fn(),
    open: vi.fn(),
    browse: vi.fn(),
  };
  return { f, first, latest, props };
}

it("shows only title links in revision order and opens the selected channel-backed page", async () => {
  const { first, latest, props } = await fixture();
  const user = userEvent.setup();
  const view = render(<NotesPage {...props} />);
  const list = screen.getByRole("list", { name: "Pages" });
  expect(
    within(list)
      .getAllByRole("link")
      .map((link) => link.getAttribute("aria-label")),
  ).toEqual(["Latest page", "First page"]);
  expect(list).not.toHaveTextContent("Searchable body");
  expect(
    within(list)
      .getAllByRole("listitem")
      .map(
        (row) =>
          row.querySelector("a")?.getAttribute("aria-label") ??
          row.textContent?.trim(),
      ),
  ).toEqual(["Latest page", "First page", "New page"]);
  expect(
    within(list).getByRole("button", { name: "New page" }),
  ).toHaveAttribute("data-variant", "text");
  expect(screen.getByRole("link", { name: "Latest page" })).toHaveAttribute(
    "href",
    noteUrl(latest, props.community),
  );
  await user.click(screen.getByRole("link", { name: "Latest page" }));
  expect(props.open).toHaveBeenCalledWith(latest);
  const updated = {
    ...first,
    event: { ...first.event, created_at: latest.event.created_at + 1 },
  };
  view.rerender(<NotesPage {...props} entries={[updated, latest]} />);
  expect(
    within(list)
      .getAllByRole("link")
      .map((link) => link.getAttribute("aria-label")),
  ).toEqual(["First page", "Latest page"]);
  expect(
    within(list)
      .getAllByRole("listitem")
      .map(
        (row) =>
          row.querySelector("a")?.getAttribute("aria-label") ??
          row.textContent?.trim(),
      ),
  ).toEqual(["First page", "Latest page", "New page"]);
});

it("retains mounted editor state across Back and focuses the full-view Back button", async () => {
  const { first, latest, props } = await fixture();
  const user = userEvent.setup();
  function Host() {
    const [selected, select] = useState("browse");
    const searchRef = useRef<HTMLElement>(null);
    return (
      <NotesPage
        {...props}
        selected={selected}
        searchRef={searchRef}
        open={(note) => select(noteKey(note))}
        browse={() => select("browse")}
        items={[first, latest].map((note) => ({
          id: noteKey(note),
          label: note.title,
          content: (
            <label>
              {note.title} draft
              <input defaultValue="" />
            </label>
          ),
        }))}
      />
    );
  }
  render(<Host />);
  await user.click(screen.getByRole("link", { name: "First page" }));
  expect(screen.getByRole("button", { name: "Back to pages" })).toHaveFocus();
  await user.type(
    screen.getByRole("textbox", { name: "First page draft" }),
    "Unsaved work",
  );
  await user.click(screen.getByRole("button", { name: "Back to pages" }));
  await user.click(screen.getByRole("link", { name: "Latest page" }));
  expect(
    screen.queryByRole("textbox", { name: "First page draft" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Back to pages" }));
  await user.click(screen.getByRole("link", { name: "First page" }));
  expect(screen.getByRole("textbox", { name: "First page draft" })).toHaveValue(
    "Unsaved work",
  );
});

it("keeps loading and failed reads distinct from empty and retains useful content for refresh recovery", async () => {
  const { props } = await fixture();
  const user = userEvent.setup();
  const view = render(<NotesPage {...props} entries={[]} loading />);
  expect(screen.getByRole("button", { name: "Refresh pages" })).toHaveAttribute(
    "aria-busy",
    "true",
  );
  expect(screen.queryByText("No pages yet")).not.toBeInTheDocument();
  view.rerender(<NotesPage {...props} error="Cannot read pages" />);
  expect(screen.getByRole("alert")).toHaveTextContent("Cannot read pages");
  expect(screen.getByRole("link", { name: "Latest page" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Refresh pages" }));
  expect(props.refresh).toHaveBeenCalledOnce();
  view.rerender(<NotesPage {...props} entries={[]} canFilter={false} />);
  expect(screen.getByText("No pages yet")).toBeVisible();
  expect(screen.getByRole("button", { name: "New page" })).toBeVisible();
  const filter = screen.getByRole("button", { name: "Filter pages" });
  expect(filter).toBeDisabled();
  await user.click(filter);
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  view.rerender(<NotesPage {...props} entries={[]} trash />);
  expect(filter).toBeEnabled();
  await user.click(filter);
  await user.click(
    await screen.findByRole("menuitemcheckbox", { name: "Show deleted pages" }),
  );
  expect(props.showDeleted).toHaveBeenCalledWith(false, expect.anything());
});

it("searches loaded pages and delegates filters, creation and pagination to the workspace", async () => {
  const { props } = await fixture();
  const user = userEvent.setup();
  const view = render(<NotesPage {...props} query="searchable" more />);
  expect(
    screen.getAllByRole("link").map((link) => link.getAttribute("aria-label")),
  ).toEqual(["Latest page"]);
  const filter = screen.getByRole("button", { name: "Filter pages" });
  expect(
    screen.queryByRole("checkbox", { name: "Show deleted pages" }),
  ).not.toBeInTheDocument();
  await user.click(filter);
  const deleted = await screen.findByRole("menuitemcheckbox", {
    name: "Show deleted pages",
  });
  expect(deleted).not.toBeChecked();
  await user.click(deleted);
  expect(vi.mocked(props.showDeleted).mock.calls[0]?.[0]).toBe(true);
  view.rerender(<NotesPage {...props} query="searchable" more trash />);
  await user.click(filter);
  expect(
    await screen.findByRole("menuitemcheckbox", { name: "Show deleted pages" }),
  ).toBeChecked();
  await user.keyboard("{Escape}");
  expect(filter).toHaveFocus();
  await user.click(screen.getByRole("button", { name: "New page" }));
  expect(props.create).toHaveBeenCalledOnce();
  await user.click(screen.getByRole("button", { name: "Load more pages" }));
  expect(props.loadMore).toHaveBeenCalledOnce();
  await user.click(screen.getByRole("searchbox", { name: "Search pages" }));
  await user.keyboard("{Enter}");
  expect(props.search).toHaveBeenCalledWith("searchable", true);
  view.rerender(<NotesPage {...props} query="no results" />);
  expect(screen.getByText("No matching pages.")).toBeVisible();
  expect(screen.queryAllByRole("link")).toHaveLength(0);
});

it("explains sharing and retained history with standard popup focus return", async () => {
  const { props } = await fixture();
  const user = userEvent.setup();
  render(<NotesPage {...props} />);
  const about = screen.getByRole("button", { name: "About pages" });
  await user.click(about);
  expect(
    await screen.findByText(/Access includes retained revisions/),
  ).toBeVisible();
  expect(screen.getByText(/relay operator can read/)).toBeVisible();
  await user.keyboard("{Escape}");
  expect(about).toHaveFocus();
});
