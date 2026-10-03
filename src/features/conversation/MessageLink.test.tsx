// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "../../shared/design-system/ui/Toast";

import { renderToStaticMarkup } from "react-dom/server";
import type { Contribution } from "../../plugins/contributions";
import type { LinkRenderer } from "./contracts";
import { MessageLink, resolveLink } from "./MessageLink";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const entry: Contribution<LinkRenderer> = {
  id: "link",
  title: "Link",
  key: "test/link",
  pluginId: "test",
  revision: "one",
  matches: () => true,
  className: "link-style",
  component: () => <span>Link face</span>,
};
const url = "https://example.com/path?query=yes";
it("keeps anchor destination and host semantics with and without presentation", () => {
  const registry = { snapshot: () => [entry], subscribe: () => () => {} };
  const html = renderToStaticMarkup(
    <MessageLink url={url} registry={registry} onOpenLink={() => true} />,
  );
  expect(html).toContain(`href="${url}"`);
  expect(html).toContain('target="_blank"');
  expect(html).toContain('rel="noopener noreferrer"');
  expect(html).toContain('class="link-style"');
  expect(html).toContain("Link face");
  const fallback = renderToStaticMarkup(
    <MessageLink url={url} registry={undefined} onOpenLink={() => true} />,
  );
  expect(fallback).toContain(`>${url}</a>`);
  expect(fallback).not.toContain("data-link-renderer");
});
it("skips throwing and unmatched renderers, with first matching presentation winning", () => {
  const broken = {
    ...entry,
    matches() {
      throw new Error("matcher failed");
    },
  };
  const miss = { ...entry, matches: () => false };
  expect(resolveLink(url, [broken, miss, entry, { ...entry }])).toBe(entry);
  expect(resolveLink(url, [broken, miss])).toBeUndefined();
});

function mount(target = url, interactive = true) {
  const onOpenLink = vi.fn(() => true);
  render(
    <ToastProvider>
      <MessageLink
        url={target}
        registry={undefined}
        onOpenLink={onOpenLink}
        interactive={interactive}
        label="Message destination"
      />
    </ToastProvider>,
  );
  return {
    get anchor() {
      return screen.getByRole("link");
    },
    onOpenLink,
  };
}

it("opens a two-item context menu with the untouched external destination, not the pane", async () => {
  const user = userEvent.setup();
  const target = "https://github.com/block/buzz/pull/1?view=all#discussion_r1";
  const { anchor, onOpenLink } = mount(target);
  fireEvent.contextMenu(anchor);
  const external = await screen.findByRole("menuitem", {
    name: "Open in browser",
  });
  expect(
    screen.getAllByRole("menuitem").map((item) => item.textContent),
  ).toEqual(["Open in browser", "Copy link"]);
  expect(external).toHaveAttribute("href", target);
  expect(external).toHaveAttribute("target", "_blank");
  expect(external).toHaveAttribute("rel", "noopener noreferrer");
  expect(onOpenLink).not.toHaveBeenCalled();
  // Prevent jsdom navigation; real browser/desktop handoff is exercised separately.
  external.addEventListener("click", (event) => event.preventDefault());
  await user.click(external);
  expect(onOpenLink).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
  );
});

it.each(["{Shift>}{F10}{/Shift}", "{ContextMenu}"])(
  "supports keyboard invocation %s, copying, dismissal and focus return",
  async (keys) => {
    const user = userEvent.setup();
    const write = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue();
    const { anchor, onOpenLink } = mount(`${url}#exact-fragment`);
    anchor.focus();
    await user.keyboard(keys);
    const copy = await screen.findByRole("menuitem", { name: "Copy link" });
    copy.focus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(write).toHaveBeenCalledWith(`${url}#exact-fragment`),
    );
    expect(await screen.findByText("Link copied")).toBeInTheDocument();
    await waitFor(() => expect(anchor).toHaveFocus());
    expect(onOpenLink).not.toHaveBeenCalled();
    await user.keyboard(keys);
    await screen.findByRole("menu");
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(anchor).toHaveFocus());
  },
);

it("reports a clipboard failure and allows an explicit retry", async () => {
  const user = userEvent.setup();
  const write = vi
    .spyOn(navigator.clipboard, "writeText")
    .mockRejectedValueOnce(new Error("denied"))
    .mockResolvedValue();
  const { anchor, onOpenLink } = mount();
  fireEvent.contextMenu(anchor);
  await user.click(await screen.findByRole("menuitem", { name: "Copy link" }));
  expect(
    await screen.findByText(
      "Couldn’t copy the link. Try again from the link menu.",
    ),
  ).toBeInTheDocument();
  fireEvent.contextMenu(anchor);
  await user.click(await screen.findByRole("menuitem", { name: "Copy link" }));
  expect(await screen.findByText("Link copied")).toBeInTheDocument();
  expect(write).toHaveBeenCalledTimes(2);
  expect(onOpenLink).not.toHaveBeenCalled();
});

it.each([
  "buzz://channel/alpha",
  "mailto:hello@example.com",
  "ftp://example.com/file",
])("leaves non-HTTP(S) link context menus alone: %s", (target) => {
  const { anchor } = mount(target);
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
  });
  fireEvent(anchor, event);
  expect(event.defaultPrevented).toBe(false);
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});

it("leaves noninteractive message content without a menu or anchor", () => {
  mount(url, false);
  fireEvent.contextMenu(screen.getByText("Message destination"));
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});

it("preserves ordinary pane interception and modified or middle-click fallback", () => {
  const { anchor, onOpenLink } = mount();
  const ordinary = new MouseEvent("click", { bubbles: true, cancelable: true });
  fireEvent(anchor, ordinary);
  expect(ordinary.defaultPrevented).toBe(true);
  expect(onOpenLink).toHaveBeenCalledOnce();
  onOpenLink.mockClear();
  for (const modifier of ["ctrlKey", "metaKey", "shiftKey", "altKey"]) {
    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      [modifier]: true,
    });
    // Avoid jsdom trying to navigate; capture the component's prevention before that.
    let prevented: boolean | undefined;
    document.addEventListener(
      "click",
      (click) => {
        prevented = click.defaultPrevented;
        click.preventDefault();
      },
      { once: true },
    );
    fireEvent(anchor, event);
    expect(prevented).toBe(false);
  }
  fireEvent(
    anchor,
    new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }),
  );
  expect(onOpenLink).not.toHaveBeenCalled();
});
