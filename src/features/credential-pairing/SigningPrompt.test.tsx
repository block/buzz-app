// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RelayData } from "../relay/service";
import { SigningPrompt } from "./SigningPrompt";
import type { SignRequest } from "./service";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const channel = "0b6b3a8e-1d7c-4f0e-9a52-6a1f0c5d2e77";
let channelNames: Record<string, string>;
const listeners = new Set<() => void>();
/** The open community's session, as far as the prompt reads it. */
const relay = (() => {
  const snapshot = {
    origin: "https://relay.example",
    session: {
      channels: {
        get: (id: string) =>
          channelNames[id] ? { id, name: channelNames[id] } : undefined,
        subscribeList(listener: () => void) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      profiles: {
        snapshot: () => new Map(),
        subscribe: () => () => {},
      },
    },
  };
  return {
    snapshot: () => snapshot,
    subscribe: () => () => {},
  } as unknown as RelayData;
})();

const handlers = new Map<string, (event: { payload: unknown }) => void>();
beforeEach(() => {
  handlers.clear();
  listeners.clear();
  channelNames = { [channel]: "general" };
  vi.mocked(invoke).mockReset().mockResolvedValue(undefined);
  vi.mocked(listen).mockImplementation(async (name, handler) => {
    const own = handler as (event: { payload: unknown }) => void;
    handlers.set(name, own);
    return () => {
      if (handlers.get(name) === own) handlers.delete(name);
    };
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const request: SignRequest = {
  id: "s1",
  pairing: "p1",
  client: "buzz-cli",
  relay: "wss://relay.example/",
  kind: 9022,
  tags: [["h", channel]],
  expiresIn: 120,
  windowSeconds: 300,
};
const ask = async (payload: SignRequest) => {
  await vi.waitFor(() =>
    expect(handlers.has("credential-sign-request")).toBe(true),
  );
  act(() => handlers.get("credential-sign-request")?.({ payload }));
};
/** What the page told native about its prompt, in order. */
const prompts = () =>
  vi
    .mocked(invoke)
    .mock.calls.filter(([command]) => command === "credential_sign_prompt")
    .map(([, args]) => args);
const answered = (id: string, answer: string) =>
  expect(invoke).toHaveBeenCalledWith("credential_sign_answer", { id, answer });
/** Holds each `listen` until it is released, oldest first. As in Tauri, a
 * handler already hears events while its listener is still being set up. */
const holdListen = () => {
  const held: (() => void)[] = [];
  const listening = vi.mocked(listen).getMockImplementation();
  vi.mocked(listen).mockImplementation(async (...args) => {
    const released = new Promise<void>((resolve) => {
      held.push(resolve);
    });
    const unlisten = await listening?.(...args);
    await released;
    return unlisten ?? (() => {});
  });
  return {
    release: () => held.shift()?.(),
    releaseAll: () => {
      for (const release of held.splice(0)) release();
    },
  };
};
/** Runs every promise reaction already queued: the mocks settle only in
 * microtasks, which all run before the next task. */
const settled = () => new Promise((resolve) => setTimeout(resolve));

it("names the tool, the action and the community, with Deny focused", async () => {
  render(<SigningPrompt relay={relay} />);
  await ask(request);
  const dialog = await screen.findByRole("alertdialog");
  expect(dialog).toHaveTextContent("buzz-cli wants to leave #general");
  expect(dialog).toHaveTextContent("wss://relay.example/");
  expect(dialog).toHaveTextContent("Expires in 120 s");
  expect(dialog).toHaveTextContent(
    "Allow for 5 min lets buzz-cli leave channels without asking again.",
  );
  await vi.waitFor(() =>
    expect(screen.getByRole("button", { name: "Deny" })).toHaveFocus(),
  );
  expect(
    screen
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label") ?? button.textContent),
  ).toEqual(["Close", "Deny", "Allow for 5 min", "Allow once"]);
});

it.each([
  { button: "Deny", answer: "deny" },
  { button: "Allow once", answer: "once" },
  { button: "Allow for 5 min", answer: "window" },
])("answers $answer from $button and closes", async ({ button, answer }) => {
  render(<SigningPrompt relay={relay} />);
  await ask(request);
  await userEvent.click(await screen.findByRole("button", { name: button }));
  answered("s1", answer);
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("denies on Escape and on Close", async () => {
  render(<SigningPrompt relay={relay} />);
  await ask(request);
  await screen.findByRole("alertdialog");
  await userEvent.keyboard("{Escape}");
  answered("s1", "deny");
  expect(screen.queryByRole("alertdialog")).toBeNull();
  vi.mocked(invoke).mockClear();
  await ask({ ...request, id: "s2" });
  await userEvent.click(await screen.findByRole("button", { name: "Close" }));
  answered("s2", "deny");
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("says what the window allows, and takes its length from the request", async () => {
  render(<SigningPrompt relay={relay} />);
  await ask({ ...request, windowSeconds: 600, kind: 9021 });
  expect(await screen.findByRole("alertdialog")).toHaveTextContent(
    "Allow for 10 min lets buzz-cli join channels without asking again.",
  );
  expect(
    screen.getByRole("button", { name: "Allow for 10 min" }),
  ).toBeInTheDocument();
  await ask({ ...request, id: "s2", windowSeconds: 45 });
  expect(
    await screen.findByRole("button", { name: "Allow for 45 s" }),
  ).toBeInTheDocument();
});

it("offers only Allow once for a kind native code allows only once", async () => {
  render(<SigningPrompt relay={relay} />);
  await ask({ ...request, kind: 9008, windowSeconds: 0 });
  expect(await screen.findByRole("alertdialog")).not.toHaveTextContent(
    "without asking again",
  );
  expect(
    screen
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label") ?? button.textContent),
  ).toEqual(["Close", "Deny", "Allow once"]);
});

it("does not take a deletion's claimed kind as what it deletes", async () => {
  render(<SigningPrompt relay={relay} />);
  await ask({
    ...request,
    kind: 5,
    windowSeconds: 0,
    tags: [
      ["e", "m1"],
      ["k", "7"],
    ],
  });
  expect(await screen.findByRole("alertdialog")).toHaveTextContent(
    "buzz-cli wants to delete something you or your agents posted",
  );
});

it("shows a short id for a channel it does not hold, or one in another community", async () => {
  channelNames = {};
  render(<SigningPrompt relay={relay} />);
  await ask(request);
  expect(await screen.findByRole("alertdialog")).toHaveTextContent(
    "buzz-cli wants to leave channel 0b6b3a8e",
  );
  act(() => handlers.get("credential-sign-closed")?.({ payload: "s1" }));
  // A name the open community holds is not trusted for another's request.
  channelNames = { [channel]: "general" };
  await ask({ ...request, id: "s2", relay: "wss://elsewhere.example/" });
  expect(await screen.findByRole("alertdialog")).toHaveTextContent(
    "buzz-cli wants to leave channel 0b6b3a8e",
  );
});

it("names a channel once the community lists it", async () => {
  channelNames = {};
  render(<SigningPrompt relay={relay} />);
  await ask(request);
  expect(await screen.findByRole("alertdialog")).toHaveTextContent(
    "leave channel 0b6b3a8e",
  );
  channelNames = { [channel]: "general" };
  act(() => {
    for (const listener of listeners) listener();
  });
  expect(screen.getByRole("alertdialog")).toHaveTextContent("leave #general");
});

it("closes when native ends the request, and when its time runs out", async () => {
  render(<SigningPrompt relay={relay} />);
  await ask(request);
  await screen.findByRole("alertdialog");
  act(() => handlers.get("credential-sign-closed")?.({ payload: "other" }));
  expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  act(() => handlers.get("credential-sign-closed")?.({ payload: "s1" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  vi.useFakeTimers();
  act(() =>
    handlers.get("credential-sign-request")?.({
      payload: { ...request, id: "s3", expiresIn: 2 },
    }),
  );
  expect(screen.getByRole("alertdialog")).toHaveTextContent("Expires in 2 s");
  act(() => vi.advanceTimersByTime(2000));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(invoke).not.toHaveBeenCalledWith(
    "credential_sign_answer",
    expect.anything(),
  );
});

it("refuses the request a newer one replaces", async () => {
  render(<SigningPrompt relay={relay} />);
  await ask(request);
  await screen.findByRole("alertdialog");
  await ask({ ...request, id: "s2", kind: 9021 });
  answered("s1", "deny");
  expect(await screen.findByRole("alertdialog")).toHaveTextContent(
    "wants to join #general",
  );
});

it("refuses the open request when the page unmounts", async () => {
  const { unmount } = render(<SigningPrompt relay={relay} />);
  await ask(request);
  await screen.findByRole("alertdialog");
  unmount();
  answered("s1", "deny");
});

it("lets native ask only once it listens, and not after it leaves", async () => {
  const held = holdListen();
  const { unmount } = render(<SigningPrompt relay={relay} />);
  try {
    await vi.waitFor(() =>
      expect(handlers.has("credential-sign-closed")).toBe(true),
    );
    // While any listener is still being set up, native must not ask.
    held.release();
    await settled();
    expect(prompts()).toEqual([]);
  } finally {
    held.releaseAll();
  }
  await vi.waitFor(() => expect(prompts()).toEqual([{ mounted: true }]));
  unmount();
  expect(prompts()).toEqual([{ mounted: true }, { mounted: false }]);
});

it("refuses a request heard after it stopped, since nobody can show it", async () => {
  const held = holdListen();
  const { unmount } = render(<SigningPrompt relay={relay} />);
  try {
    await vi.waitFor(() =>
      expect(handlers.has("credential-sign-request")).toBe(true),
    );
    unmount();
    act(() => handlers.get("credential-sign-request")?.({ payload: request }));
    answered("s1", "deny");
  } finally {
    held.releaseAll();
  }
  // Once its listeners are gone, it has still never counted as listening.
  await vi.waitFor(() => expect(handlers.size).toBe(0));
  expect(prompts()).toEqual([]);
});

it("is mounted once under a development remount", async () => {
  const { unmount } = render(
    <StrictMode>
      <SigningPrompt relay={relay} />
    </StrictMode>,
  );
  await vi.waitFor(() => expect(prompts()).toEqual([{ mounted: true }]));
  unmount();
  expect(prompts()).toEqual([{ mounted: true }, { mounted: false }]);
});
