// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { Browser } from "../../../features/browser/api";
import { browserView } from "./page";

afterEach(cleanup);

let opened = 0;
/** Stands in for the host's browser view: its own address bar, and the
 * address it was opened at kept for as long as it is mounted. */
function HostView({ url }: { url: string }) {
  const [draft, setDraft] = useState(url);
  useState(() => {
    opened += 1;
  });
  return (
    <form onSubmit={(event) => event.preventDefault()}>
      <input
        aria-label="Address"
        value={draft}
        onChange={(event) => setDraft(event.currentTarget.value)}
      />
    </form>
  );
}
// Like the host, a new function on every read.
const browser = {
  available: true,
  get View() {
    return (props: { url: string }) => <HostView {...props} />;
  },
} as unknown as Browser;
const Page = browserView(browser).component;

const go = async (url: string) => {
  const address = screen.getByRole("textbox", { name: "Address" });
  await userEvent.clear(address);
  await userEvent.type(address, `${url}{Enter}`);
};

it("the host's own address bar is the only one, and where it goes is shared", async () => {
  opened = 0;
  const update = vi.fn();
  const { rerender } = render(
    <Page state={{ url: "https://a.example/" }} interactive update={update} />,
  );
  expect(screen.getAllByRole("textbox")).toHaveLength(1);
  await go("https://b.example/");
  await waitFor(() =>
    expect(update).toHaveBeenCalledWith({ url: "https://b.example/" }),
  );
  // The viewer is already there: the page isn't opened again.
  rerender(
    <Page state={{ url: "https://b.example/" }} interactive update={update} />,
  );
  expect(opened).toBe(1);
  // Someone else moved it: this viewer's page follows.
  rerender(
    <Page state={{ url: "https://c.example/" }} interactive update={update} />,
  );
  await waitFor(() => expect(opened).toBe(2));
  expect(screen.getByRole("textbox")).toHaveValue("https://c.example/");
});

it("where a follower goes in their own page isn't shared", async () => {
  const update = vi.fn();
  render(
    <Page
      state={{ url: "https://a.example/" }}
      interactive={false}
      update={update}
    />,
  );
  await go("https://b.example/");
  await new Promise((done) => setTimeout(done, 700));
  expect(update).not.toHaveBeenCalled();
});
