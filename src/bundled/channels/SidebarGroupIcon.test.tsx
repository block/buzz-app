// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, assert, expect, it, vi } from "vitest";
import { createEmojiDirectory } from "../../features/relay/emoji-directory";
import type { RelayReader } from "../../features/relay/reader";
import type { RelayEvent } from "../../features/relay/events";
import { keypair, signed } from "../../features/relay/testing";
import { SidebarGroupIcon } from "./SidebarGroupIcon";

const member = keypair();
const entry = (url = "https://relay.test/media/stamp.png", time = 1) =>
  signed(member, {
    kind: 30030,
    created_at: time,
    content: "",
    tags: [
      ["d", "buzz:custom-emoji"],
      ["emoji", "stamp", url],
    ],
  });
const owners: ReturnType<typeof createEmojiDirectory>[] = [];
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
});
function fixture(read = vi.fn<RelayReader["read"]>(async () => [entry()])) {
  const owner = createEmojiDirectory({ read });
  owners.push(owner);
  const media = vi.fn(
    (url: string): string | undefined => `/safe?url=${encodeURIComponent(url)}`,
  );
  return { owner, read, session: { emoji: owner.queries, media } };
}

it("renders Unicode without starting an emoji read", () => {
  const h = fixture();
  const view = render(<SidebarGroupIcon icon="📚" session={h.session} />);
  expect(view.container).toHaveTextContent("📚");
  expect(h.read).not.toHaveBeenCalled();
});

it("shares a background catalog read across icons, resolves case, and renders live replacements", async () => {
  let release!: (events: readonly RelayEvent[]) => void;
  const h = fixture(
    vi.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    ),
  );
  const view = render(
    <>
      <SidebarGroupIcon icon=":Stamp:" session={h.session} />
      <SidebarGroupIcon icon=":stamp:" session={h.session} />
    </>,
  );
  expect(h.read).toHaveBeenCalledOnce();
  expect(h.read).toHaveBeenCalledWith(
    [{ kinds: [30030], "#d": ["buzz:custom-emoji"], limit: 500 }],
    expect.objectContaining({ priority: "background" }),
  );
  expect(view.container.querySelectorAll("img")).toHaveLength(0);
  expect(view.container.querySelectorAll("span[data-loading]")).toHaveLength(2);
  expect(view.container).not.toHaveTextContent(":");
  expect(view.container.querySelector("[title]")).toBeNull();
  await act(async () => {
    release([entry()]);
  });
  expect(view.container.querySelectorAll("img")).toHaveLength(2);
  expect(view.container.querySelector("img")).toHaveAttribute(
    "src",
    "/safe?url=https%3A%2F%2Frelay.test%2Fmedia%2Fstamp.png",
  );
  expect(view.container.querySelectorAll("span[data-loading]")).toHaveLength(2);
  for (const image of view.container.querySelectorAll("img"))
    fireEvent.load(image);
  expect(view.container.querySelectorAll("[data-loading]")).toHaveLength(0);
  act(() => h.owner.accept([entry("https://relay.test/media/new.png", 2)]));
  expect(view.container.querySelectorAll("span[data-loading]")).toHaveLength(2);
  expect(view.container.querySelector("img")).toHaveAttribute(
    "src",
    "/safe?url=https%3A%2F%2Frelay.test%2Fmedia%2Fnew.png",
  );
  act(() =>
    h.owner.accept([
      signed(member, {
        kind: 30030,
        created_at: 3,
        content: "",
        tags: [["d", "buzz:custom-emoji"]],
      }),
    ]),
  );
  expect(view.container.querySelectorAll("img")).toHaveLength(0);
  expect(view.container).not.toHaveTextContent(":");
  expect(view.container.querySelector("[data-loading]")).toBeNull();
});

it("hides missing, blocked and failed media without ever showing shortcode text", async () => {
  const h = fixture();
  h.session.media.mockReturnValue(undefined);
  const view = render(<SidebarGroupIcon icon=":stamp:" session={h.session} />);
  await act(async () => {
    await h.session.emoji.ensure();
  });
  expect(view.container).not.toHaveTextContent(":");
  expect(view.container.querySelector("[data-loading]")).toBeNull();
  expect(view.container.querySelector("img")).toBeNull();
  h.session.media.mockReturnValue("/safe/stamp.png");
  view.rerender(<SidebarGroupIcon icon=":stamp:" session={h.session} />);
  const image = view.container.querySelector("img");
  assert.exists(image);
  expect(image).toHaveAttribute("alt", "");
  expect(view.container.querySelector("span[data-loading]")).not.toBeNull();
  fireEvent.error(image);
  expect(view.container.querySelector("img")).toBeNull();
  expect(
    view.container.querySelector("[data-sidebar-group-icon]"),
  ).toHaveAttribute("aria-hidden", "true");
  expect(view.container.querySelector("[data-loading]")).toBeNull();
  view.rerender(<SidebarGroupIcon icon=":missing:" session={h.session} />);
  expect(view.container).not.toHaveTextContent(":");
  expect(view.container.querySelector("[data-loading]")).toBeNull();
  view.rerender(<SidebarGroupIcon icon=":not valid:" session={h.session} />);
  expect(view.container).not.toHaveTextContent(":");
  expect(view.container.querySelector("[data-loading]")).toBeNull();
});

it("does not retain another community's image while its catalog loads", async () => {
  const a = fixture();
  const view = render(<SidebarGroupIcon icon=":stamp:" session={a.session} />);
  await act(async () => {
    await a.session.emoji.ensure();
  });
  expect(view.container.querySelector("img")).not.toBeNull();
  const b = fixture(vi.fn(async () => []));
  await act(async () => {
    view.rerender(<SidebarGroupIcon icon=":stamp:" session={b.session} />);
  });
  expect(view.container.querySelector("img")).toBeNull();
  expect(b.session.media).not.toHaveBeenCalled();
});

it("keeps catalog failure settled and reflects explicit recovery", async () => {
  const h = fixture(
    vi
      .fn<RelayReader["read"]>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue([entry()]),
  );
  const view = render(<SidebarGroupIcon icon=":stamp:" session={h.session} />);
  await act(async () => {
    await h.session.emoji.ensure();
  });
  expect(h.session.emoji.snapshot().status).toBe("error");
  view.rerender(<SidebarGroupIcon icon=":stamp:" session={h.session} />);
  expect(h.read).toHaveBeenCalledOnce();
  expect(view.container).not.toHaveTextContent(":");
  expect(view.container.querySelector("[data-loading]")).toBeNull();
  await act(async () => {
    await h.session.emoji.refresh();
  });
  expect(view.container.querySelector("img")).not.toBeNull();
});
