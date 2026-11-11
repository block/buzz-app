// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import { EMOJI_SET, EMOJI_SET_KIND } from "../../features/relay/emoji";
import { keypair, signed, type Key } from "../../features/relay/testing";
import { EmojiPicker } from "./EmojiPicker";

const viewer = keypair(),
  member = keypair();
const scope = "https://relay.example";
const url = "https://media.example/party.png";
const set = (key: Key, tags: string[][]) =>
  signed(key, {
    kind: EMOJI_SET_KIND,
    created_at: 1,
    content: "",
    tags: [["d", EMOJI_SET], ...tags],
  });

let owner: ReturnType<typeof createRelaySession> | undefined;

afterEach(() => {
  cleanup();
  localStorage.clear();
  owner?.dispose();
  owner = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const shadowRoot = () =>
  // The picker popup renders through a portal; the Mart element is unique.
  document.querySelector("em-emoji-picker")?.shadowRoot;

function martRoot(): ShadowRoot {
  const shadow = shadowRoot();
  if (!shadow) throw new Error("Mart has not mounted");
  return shadow;
}

/** Right-click a palette emoji by its literal title; Mart renders these inside
 * its shadow root, where jsdom still dispatches through the host listener. */
function contextMenu(literal: string) {
  const button = [...martRoot().querySelectorAll("button")].find(
    (candidate) => candidate.getAttribute("title") === literal,
  );
  if (!button) throw new Error(`no ${literal} button`);
  fireEvent.contextMenu(button, { bubbles: true, composed: true });
}

/** jsdom gives the picker no width, so the nav never renders and the bottom
 * Custom category keeps lazy rows; search surfaces palette emoji immediately. */
async function openEmojiPicker(tags: string[][]) {
  for (const name of ["ResizeObserver", "IntersectionObserver"])
    vi.stubGlobal(
      name,
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  const stored = [set(member, tags)];
  owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: keypair().pubkey,
    scope,
    media: (value) => (/^https:\/\//.test(value) ? value : undefined),
    async query(filters) {
      return stored.filter((event) =>
        filters.some(
          (filter) =>
            (!filter.kinds || filter.kinds.includes(event.kind)) &&
            (!filter.authors || filter.authors.includes(event.pubkey)),
        ),
      );
    },
  });
  render(
    <EmojiPicker
      session={owner.session}
      scope={scope}
      reaction
      disabled={false}
      insert={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Add reaction" }));
  await vi.waitFor(() => expect(shadowRoot()).toBeTruthy());
  const input = martRoot().querySelector<HTMLInputElement>(
    'input[type="search"]',
  );
  if (!input) throw new Error("Search has not rendered");
  await act(async () => {
    input.value = "party";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await vi.waitFor(() =>
    expect(martRoot().querySelector("button[title=':party:']")).toBeTruthy(),
  );
}

it("right-click favorites a palette emoji, listed before Custom", async () => {
  await openEmojiPicker([["emoji", "party", url]]);
  await act(async () => {
    contextMenu(":party:");
  });
  const item = await screen.findByRole("menuitem", { name: "Add to favorites" });
  await userEvent.click(item);
  expect(JSON.parse(localStorage.getItem("buzz.emoji.favorites") ?? "")).toEqual(
    { [scope]: ["party"] },
  );
  // The store change remounts the picker with the Favorites category.
  await vi.waitFor(() =>
    expect(
      martRoot().querySelector('.category[data-id="buzz-favorites"]'),
    ).toBeTruthy(),
  );
});

it("right-click removes a favorite and its category", async () => {
  localStorage.setItem(
    "buzz.emoji.favorites",
    JSON.stringify({ [scope]: ["party"] }),
  );
  await openEmojiPicker([["emoji", "party", url]]);
  // The pre-seeded favorite renders its own category next to the search hit.
  await vi.waitFor(() =>
    expect(
      martRoot().querySelector('.category[data-id="buzz-favorites"]'),
    ).toBeTruthy(),
  );
  await act(async () => {
    contextMenu(":party:");
  });
  await userEvent.click(
    await screen.findByRole("menuitem", { name: "Remove from favorites" }),
  );
  expect(
    JSON.parse(localStorage.getItem("buzz.emoji.favorites") ?? ""),
  ).toEqual({});
  await vi.waitFor(() =>
    expect(
      martRoot().querySelector('.category[data-id="buzz-favorites"]'),
    ).toBeNull(),
  );
});

it("does not open the favorites menu for native emoji", async () => {
  await openEmojiPicker([["emoji", "party", url]]);
  const native = [...martRoot().querySelectorAll("button")].find(
    (button) => button.getAttribute("aria-label") === "👍",
  );
  if (!native) throw new Error("no thumbs-up button");
  await act(async () => {
    fireEvent.contextMenu(native, { bubbles: true, composed: true });
  });
  expect(screen.queryByRole("menuitem")).toBeNull();
});
