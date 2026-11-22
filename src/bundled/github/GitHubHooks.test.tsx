// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { VerifiedEvent } from "nostr-tools";
import { afterEach, expect, it, vi } from "vitest";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { GitHubHooks } from "./GitHubHooks";
import { HOOK_TYPE } from "./hooks";
import { createPublisherStatus } from "./publisher";

const channel = "11111111-1111-4111-8111-111111111111";
const viewer = "c".repeat(64);
const dana = "d".repeat(64);
const scope = "https://buzz.example:viewer";

afterEach(() => cleanup());

const hook = (publisher: string, repo = "block/buzz-app", d = "hook-d") =>
  ({
    id: d.padEnd(64, "1"),
    pubkey: publisher,
    sig: "",
    created_at: 1,
    kind: 45010,
    content: JSON.stringify({ version: 1, repo }),
    tags: [
      ["d", d],
      ["h", channel],
      ["type", HOOK_TYPE],
      ["repo", repo],
      ["publisher", publisher],
    ],
  }) as VerifiedEvent;

function mount(initial: { status: string; events: VerifiedEvent[] }) {
  let snapshot = initial;
  let stored: (() => VerifiedEvent[]) | undefined;
  const listeners = new Set<() => void>();
  const sign = vi.fn(async (template: object) => ({
    ...template,
    id: "f".repeat(64),
    pubkey: viewer,
    sig: "",
  }));
  const publish = vi.fn(async () => "");
  const session = {
    viewer,
    snapshotRead: async (filters: { "#d"?: string[] }[]) =>
      (stored?.() ?? snapshot.events).filter((event) =>
        event.tags.some(([n, v]) => n === "d" && v === filters[0]?.["#d"]?.[0]),
      ),
    configArtifactWriter: { sign, publish },
    artifacts: {
      sync: () => ({
        snapshot: () => snapshot,
        subscribe(listener: () => void) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        dispose() {},
      }),
    },
  } as unknown as RelaySession;
  const ready = { status: "ready", session, scope, generation: 1 };
  const relay = {
    snapshot: () => ready,
    subscribe: () => () => {},
  } as unknown as RelayData;
  render(
    <GitHubHooks
      relay={relay}
      channelContext={{ scope, channelId: channel } as never}
      publisher={createPublisherStatus()}
      nameOf={(pubkey) => (pubkey === dana ? "Dana" : "a member")}
    />,
  );
  return {
    sign,
    reads(next: () => VerifiedEvent[]) {
      stored = next;
    },
    set(next: typeof snapshot) {
      snapshot = next;
      act(() => {
        for (const listener of listeners) listener();
      });
    },
  };
}

it("follows only once the channel's followed repositories are known, so it never follows twice", async () => {
  const user = userEvent.setup();
  const view = mount({ status: "loading", events: [] });
  await user.type(screen.getByRole("textbox"), "block/buzz-app");
  const button = screen.getByRole("button", { name: "Follow" });
  expect(button).toBeDisabled();
  expect(
    screen.getByText(/waits until this channel’s followed repositories/),
  ).toBeInTheDocument();
  await user.click(button);
  expect(view.sign).not.toHaveBeenCalled();

  view.set({ status: "live", events: [hook(dana)] });
  expect(screen.getByText("This channel already follows it.")).toBeVisible();
  expect(button).toBeDisabled();

  view.set({ status: "stale", events: [] });
  await user.clear(screen.getByRole("textbox"));
  await user.type(screen.getByRole("textbox"), "block/other");
  expect(button).toBeDisabled();

  view.set({ status: "live", events: [hook(dana)] });
  expect(button).toBeEnabled();
});

it("says when the reader can't see the channel's followed repositories, rather than that there are none", () => {
  mount({ status: "restricted", events: [] });
  expect(screen.getByRole("status")).toHaveTextContent(
    "You can’t read this channel’s followed repositories.",
  );
  expect(screen.queryByText(/No repositories followed/)).toBeNull();
});

it("names whose Buzz publishes a repository, and confirms an unfollow that stops it for everyone", async () => {
  const user = userEvent.setup();
  const view = mount({
    status: "live",
    events: [hook(dana), hook(viewer, "block/goose", "mine")],
  });
  expect(screen.getByText(/Published from Dana’s Buzz/)).toBeVisible();

  const [theirs] = screen.getAllByRole("button", { name: "Unfollow" });
  await user.click(theirs as HTMLElement);
  const dialog = screen.getByRole("alertdialog");
  expect(dialog).toHaveTextContent("Unfollow block/buzz-app?");
  expect(dialog).toHaveTextContent(
    "Dana’s Buzz stops posting its pull requests here, and their cards turn back into plain links for everyone in this channel.",
  );
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(view.sign).not.toHaveBeenCalled();

  await user.click(theirs as HTMLElement);
  await user.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Unfollow",
    }),
  );
  await vi.waitFor(() => expect(view.sign).toHaveBeenCalledTimes(1));
  const template = view.sign.mock.calls[0]?.[0] as unknown as {
    tags: string[][];
  };
  expect(template.tags).toContainEqual(["d", "hook-d"]);
  expect(template.tags).toContainEqual(["op", "delete"]);
  await vi.waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
});

it("marks a list it can't confirm is current, and names publishers only as last known", () => {
  const view = mount({ status: "live", events: [hook(dana)] });
  expect(screen.getByText(/Published from Dana’s Buzz/)).toBeVisible();
  view.set({ status: "stale", events: [hook(dana)] });
  expect(
    screen.getByText("Reconnecting. This list may be out of date."),
  ).toBeVisible();
  expect(screen.getByText("Last known publisher: Dana.")).toBeVisible();
  expect(screen.queryByText(/Published from Dana’s Buzz/)).toBeNull();
});

it("unfollows nothing when the hook changed while its confirmation was open", async () => {
  const user = userEvent.setup();
  const view = mount({ status: "live", events: [hook(dana)] });
  await user.click(screen.getByRole("button", { name: "Unfollow" }));
  // Someone points the same hook at another repository before the confirm.
  view.reads(() => [
    { ...hook(dana, "block/other"), id: "2".repeat(64), created_at: 2 },
  ]);
  await user.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Unfollow",
    }),
  );
  await vi.waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(
      "block/buzz-app changed since you chose it.",
    ),
  );
  expect(view.sign).not.toHaveBeenCalled();
  expect(screen.queryByRole("alertdialog")).toBeNull();
});
