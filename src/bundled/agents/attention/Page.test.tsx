// @vitest-environment jsdom
import * as React from "react";
import userEvent from "@testing-library/user-event";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Context } from "../../../plugins/author";
import { createPage, describe } from "./Page";

afterEach(cleanup);
const channel = "11111111-1111-1111-1111-111111111111";
it("keeps listening channels distinct from destinations and respects rearmed timer usage", () => {
  expect(
    describe(
      {
        type: "event",
        interest_id: "task",
        enabled: true,
        since: 0,
        kinds: [],
        channels: ["listen"],
        channel: "report",
      },
      (value) => value,
    ),
  ).toMatchObject({ detail: "Listens in listen · Delivers to report" });
  expect(
    describe(
      {
        type: "timer",
        interest_id: "once",
        enabled: true,
        prompt: "Check",
        armed_at: 100,
        interval_secs: 60,
        max_occurrences: 1,
        expires_at: null,
      },
      (value) => value,
      110,
    ).title,
  ).toMatch(/^Once · /);
  expect(
    describe(
      {
        type: "timer",
        interest_id: "task",
        enabled: true,
        prompt: "Check",
        armed_at: 100,
        interval_secs: 60,
        max_occurrences: 2,
        expires_at: null,
      },
      (value) => value,
      110,
      2,
    ).spent,
  ).toBe(true);
});
it("hides agents without subscriptions, reacts to changes and surfaces save errors", async () => {
  let changed = () => {};
  let enabled = true;
  const record = () => ({
    pubkey: "a",
    name: "Ada",
    attentionEnabled: enabled,
    attentionHistory: {
      "watch/check": {
        lastWokeAt: Math.floor(Date.now() / 1000) - 180,
        output: "build succeeded",
      },
    },
    timers: {},
    attention: {
      "interest/task": {
        slug: "interest/task",
        modifiedAt: 1,
        value: { type: "interest", instructions: "Keep releases moving." },
      },
      "watch/check": {
        slug: "watch/check",
        modifiedAt: 1,
        value: {
          type: "source",
          interest_id: "task",
          enabled: false,
          provider: "attention/command",
          channel,
          config: { command: ["check"] },
        },
      },
    },
  });
  let snapshot = {
    status: "ready",
    running: [
      record(),
      { ...record(), name: "Bo", pubkey: "b", attention: {} },
    ],
  };
  const disconnected = { status: "disconnected" };
  const save = vi.fn(async () => {
    throw new Error("Save failed");
  });
  const ctx = {
    react: React,
    agents: {
      snapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        changed = listener;
        return () => {};
      },
      save,
    },
    relay: { snapshot: () => disconnected, subscribe: () => () => {} },
  } as unknown as Context;
  const Page = createPage(ctx);
  render(React.createElement(Page));
  expect(screen.queryByRole("region", { name: "Bo" })).toBeNull();
  const ada = screen.getByRole("region", { name: "Ada" });
  expect(within(ada).getByRole("heading", { name: "task" })).toBeTruthy();
  expect(within(ada).getByText("1 subscription")).toBeTruthy();
  fireEvent.click(
    within(ada).getByRole("button", { name: "Details for task" }),
  );
  expect(within(ada).getByText("Woke 3m ago")).toBeTruthy();
  expect(within(ada).getByText("build succeeded")).toBeTruthy();
  expect(within(ada).getByRole("heading", { name: "Command" })).toBeTruthy();
  expect(ada.querySelector(".attention-details code")?.textContent).toBe(
    "check",
  );
  expect(
    ada.querySelector(
      ".attention-instructions summary .attention-instructions-preview",
    ),
  ).toBeNull();
  expect(
    ada.querySelector(".attention-instructions-preview")?.textContent,
  ).toBe("Keep releases moving.");
  expect(
    ada.querySelector("details.attention-instructions")?.hasAttribute("open"),
  ).toBe(false);
  expect(
    within(screen.getByRole("region", { name: "Interest task" })).getByRole(
      "switch",
      { name: "Subscription task" },
    ),
  ).toBeTruthy();
  expect(within(ada).getByText("Paused")).toBeTruthy();
  fireEvent.click(
    within(ada).getByRole("switch", { name: "Attention for Ada" }),
  );
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toBe("Save failed"),
  );
  expect(save).toHaveBeenCalledWith("a", { attentionEnabled: false });
  await act(async () => {
    enabled = false;
    snapshot = { ...snapshot, running: [record()] };
    changed();
  });
  expect(screen.queryByRole("region", { name: "Bo" })).toBeNull();
  expect(
    within(ada)
      .getByRole("switch", { name: "Attention for Ada" })
      .getAttribute("aria-checked"),
  ).toBe("false");
});

it.each(["source", "event", "timer"] as const)(
  "toggles and deletes only the selected %s subscription",
  async (type) => {
    let changed = () => {};
    const watch =
      type === "source"
        ? {
            type,
            provider: "attention/command",
            config: { command: ["check"] },
          }
        : type === "event"
          ? { type, channels: ["listen"] }
          : {
              type,
              prompt: "Check the release",
              interval_secs: 60,
              armed_at: 100,
              max_occurrences: null,
              expires_at: null,
            };
    const value = { ...watch, enabled: true, interest_id: "release", channel };
    let agent = {
      pubkey: "a",
      name: "Ada",
      attentionEnabled: true,
      timers: {},
      attention: {
        "interest/release": {
          slug: "interest/release",
          modifiedAt: 1,
          value: { type: "interest", instructions: "Keep releases moving." },
        },
        "watch/check": { slug: "watch/check", modifiedAt: 1, value },
      },
    };
    let snapshot = { status: "ready", running: [agent] };
    const save = vi.fn(
      async (_key: string, patch: { attention: Record<string, unknown> }) => {
        const attention = { ...agent.attention } as Record<string, unknown>;
        for (const [slug, value] of Object.entries(patch.attention)) {
          if (value === null) delete attention[slug];
          else attention[slug] = { slug, modifiedAt: 2, value };
        }
        agent = { ...agent, attention: attention as typeof agent.attention };
        snapshot = { ...snapshot, running: [agent] };
        changed();
      },
    );
    const disconnected = { status: "disconnected" };
    const ctx = {
      react: React,
      agents: {
        snapshot: () => snapshot,
        subscribe: (listener: () => void) => {
          changed = listener;
          return () => {};
        },
        save,
      },
      relay: { snapshot: () => disconnected, subscribe: () => () => {} },
    } as unknown as Context;
    render(React.createElement(createPage(ctx)));
    fireEvent.click(
      screen.getByRole("switch", { name: "Subscription release" }),
    );
    await waitFor(() =>
      expect(
        screen
          .getByRole("switch", { name: "Subscription release" })
          .getAttribute("aria-checked"),
      ).toBe("false"),
    );
    expect(save).toHaveBeenLastCalledWith("a", {
      attention: { "watch/check": { ...value, enabled: false } },
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete release" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("switch", { name: "Subscription release" }),
      ).toBeNull(),
    );
    expect(save).toHaveBeenLastCalledWith("a", {
      attention: { "watch/check": null },
    });
    expect(agent.attention["interest/release"]).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Ada" })).toBeNull();
    expect(screen.getByText(/No subscriptions yet/)).toBeTruthy();
  },
);

it("keeps subscription controls disabled while saving and preserves the row on failure", async () => {
  const record = {
    pubkey: "a",
    name: "Ada",
    attentionEnabled: true,
    timers: {},
    attention: {
      "watch/check": {
        slug: "watch/check",
        modifiedAt: 1,
        value: {
          type: "source",
          name: "Build",
          interest_id: "task",
          enabled: true,
          provider: "attention/command",
          config: { command: ["check"] },
        },
      },
    },
  };
  const snapshot = { status: "ready", running: [record] };
  const disconnected = { status: "disconnected" };
  let reject!: (reason: Error) => void;
  const held = new Promise<void>((_resolve, fail) => {
    reject = fail;
  });
  const save = vi.fn(() => held);
  const ctx = {
    react: React,
    agents: { snapshot: () => snapshot, subscribe: () => () => {}, save },
    relay: { snapshot: () => disconnected, subscribe: () => () => {} },
  } as unknown as Context;
  render(React.createElement(createPage(ctx)));
  const toggle = screen.getByRole("switch", {
    name: "Subscription Build",
  }) as HTMLButtonElement;
  const remove = screen.getByRole("button", {
    name: "Delete Build",
  }) as HTMLButtonElement;
  fireEvent.click(toggle);
  await waitFor(() =>
    expect(toggle.getAttribute("aria-disabled")).toBe("true"),
  );
  expect(remove.disabled).toBe(true);
  await act(async () => reject(new Error("Could not save")));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toBe("Could not save"),
  );
  expect(toggle.getAttribute("aria-disabled")).not.toBe("true");
  expect(remove.disabled).toBe(false);
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(save).toHaveBeenCalledTimes(1);
});

it("resolves agent avatars through relay media, updates pictures and falls back on failure", async () => {
  let changed = () => {};
  let agent = {
    pubkey: "a",
    name: "Ada",
    picture: "https://example.com/avatar.png",
    attentionEnabled: true,
    timers: {},
    attention: {
      "watch/check": {
        slug: "watch/check",
        modifiedAt: 1,
        value: {
          type: "source",
          interest_id: "task",
          enabled: true,
          provider: "attention/command",
          config: { command: ["check"] },
        },
      },
    },
  };
  let snapshot = { status: "ready", running: [agent] };
  const media = vi.fn(
    (picture: string) => `https://media.example/${encodeURIComponent(picture)}`,
  );
  const connection = { status: "ready", session: { media } };
  const ctx = {
    react: React,
    agents: {
      snapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        changed = listener;
        return () => {};
      },
    },
    relay: { snapshot: () => connection, subscribe: () => () => {} },
  } as unknown as Context;
  const { container } = render(React.createElement(createPage(ctx)));
  expect(media).toHaveBeenCalledWith("https://example.com/avatar.png", "small");
  const image = container.querySelector("img") as HTMLImageElement;
  expect(image.src).toBe(
    "https://media.example/https%3A%2F%2Fexample.com%2Favatar.png",
  );
  fireEvent.load(image);
  expect(image.getAttribute("data-loaded")).toBe("true");
  expect(container.querySelector(".buzz-avatar")?.textContent).toBe("");
  const picture = "data:image/png;base64,AA==";
  await act(async () => {
    agent = { ...agent, picture };
    snapshot = { ...snapshot, running: [agent] };
    changed();
  });
  const replacement = container.querySelector("img") as HTMLImageElement;
  expect(replacement.src).toBe(picture);
  expect(replacement.getAttribute("data-loaded")).toBeNull();
  fireEvent.error(replacement);
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector(".buzz-avatar")?.textContent).toBe("A");
});

it("enables a chosen empty agent without creating subscriptions and reports failures", async () => {
  const snapshot = {
    status: "ready",
    running: [
      {
        pubkey: "b",
        name: "Bo",
        attentionEnabled: false,
        timers: {},
        attention: {},
      },
    ],
  };
  const save = vi
    .fn()
    .mockRejectedValueOnce(new Error("Enable failed"))
    .mockResolvedValueOnce(undefined);
  const disconnected = { status: "disconnected" };
  const ctx = {
    react: React,
    agents: { snapshot: () => snapshot, subscribe: () => () => {}, save },
    relay: { snapshot: () => disconnected, subscribe: () => () => {} },
  } as unknown as Context;
  render(React.createElement(createPage(ctx)));
  expect(screen.queryByRole("region", { name: "Bo" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Add agent" }));
  expect(
    (
      screen.getByRole("button", {
        name: "Enable Attention",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: "Agent" }));
  await user.click(await screen.findByRole("option", { name: "Bo" }));
  fireEvent.click(screen.getByRole("button", { name: "Enable Attention" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toBe("Enable failed"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Enable Attention" }));
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toContain(
      "Attention enabled for Bo",
    ),
  );
  expect(save).toHaveBeenLastCalledWith("b", { attentionEnabled: true });
  expect(screen.queryByRole("form")).toBeNull();
  expect(screen.queryByRole("region", { name: "Bo" })).toBeNull();
});

it("shows a standalone subscription without a synthetic Interest group or a data rewrite", () => {
  const save = vi.fn();
  const snapshot = {
    status: "ready",
    running: [
      {
        pubkey: "a",
        name: "Ada",
        attentionEnabled: true,
        timers: {},
        attention: {
          "watch/check": {
            slug: "watch/check",
            modifiedAt: 1,
            value: {
              type: "source",
              name: "Release check",
              enabled: false,
              prompt: "Report blockers",
              provider: "attention/command",
              config: { command: ["check"] },
            },
          },
        },
      },
    ],
  };
  const disconnected = { status: "disconnected" };
  const ctx = {
    react: React,
    agents: { snapshot: () => snapshot, subscribe: () => () => {}, save },
    relay: { snapshot: () => disconnected, subscribe: () => () => {} },
  } as unknown as Context;
  render(React.createElement(createPage(ctx)));
  expect(
    screen.getByRole("switch", { name: "Subscription Release check" }),
  ).toBeTruthy();
  expect(screen.queryByRole("region", { name: /^Interest / })).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Details for Release check" }),
  );
  expect(screen.queryByText("Report blockers")).toBeNull();
  expect(screen.getByText("Paused")).toBeTruthy();
  expect(save).not.toHaveBeenCalled();
});

it("keeps unreadable legacy watches visible and removes only the selected object", async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  const snapshot = {
    status: "ready",
    running: [
      {
        pubkey: "a",
        name: "Ada",
        attentionEnabled: true,
        timers: {},
        attention: {},
        skipped: {
          "watch/old": {
            slug: "watch/old",
            problem: "Legacy filter needs repair",
          },
        },
      },
    ],
  };
  const disconnected = { status: "disconnected" };
  const ctx = {
    react: React,
    agents: { snapshot: () => snapshot, subscribe: () => () => {}, save },
    relay: { snapshot: () => disconnected, subscribe: () => () => {} },
  } as unknown as Context;
  render(React.createElement(createPage(ctx)));
  expect(screen.getByText("Legacy filter needs repair")).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Remove unreadable watch/old" }),
  );
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith("a", {
      attention: { "watch/old": null },
    }),
  );
});

it("scans subscription types and each subscription destination while keeping raw configuration collapsed", () => {
  const snapshot = {
    status: "ready",
    running: [
      {
        pubkey: "a",
        name: "Ada",
        attentionEnabled: true,
        timers: {},
        attention: {
          "interest/release": {
            slug: "interest/release",
            modifiedAt: 1,
            value: { type: "interest", instructions: "Watch the release." },
          },
          "watch/pr": {
            slug: "watch/pr",
            modifiedAt: 1,
            value: {
              type: "source",
              name: "Release checks",
              interest_id: "release",
              enabled: true,
              provider: "attention/github-pr",
              config: { pr: "https://github.com/block/buzz-app/pull/1578" },
              channel,
            },
          },
          "watch/messages": {
            slug: "watch/messages",
            modifiedAt: 1,
            value: {
              type: "event",
              name: "Discussion",
              interest_id: "release",
              enabled: true,
              channels: ["listen"],
              channel: "listen",
            },
          },
        },
      },
    ],
  };
  const connection = {
    status: "ready",
    session: {
      channels: {
        ensureList() {},
        subscribeList: () => () => {},
        list: () => channels,
      },
      media: () => "",
    },
  };
  const channels = {
    channels: [
      { id: channel, name: "Berd-call", channelType: "solo" },
      { id: "listen", name: "buzz-github-prs", channelType: "stream" },
    ],
  };
  const ctx = {
    react: React,
    agents: { snapshot: () => snapshot, subscribe: () => () => {} },
    relay: { snapshot: () => connection, subscribe: () => () => {} },
  } as unknown as Context;
  render(React.createElement(createPage(ctx)));
  const icon = (name: string) =>
    screen
      .getByTitle(`Delivers to ${name}`)
      .querySelector("path")
      ?.getAttribute("d");
  expect(screen.getByTitle("Delivers to Berd-call").textContent).toBe(
    "→Berd-call",
  );
  expect(icon("Berd-call")).toBeTruthy();
  expect(icon("buzz-github-prs")).toBeTruthy();
  expect(icon("Berd-call")).not.toBe(icon("buzz-github-prs"));
  expect(screen.getByText("GitHub PR")).toBeTruthy();
  expect(screen.getByText("Messages")).toBeTruthy();
  expect(screen.getByText("buzz-app#1578")).toBeTruthy();
  expect(screen.queryByText("On")).toBeNull();
  expect(screen.queryByText("Shared instructions")).toBeNull();
  expect(screen.queryByText("Show raw")).toBeNull();
  expect(
    screen.getAllByRole("button", { name: "New subscription" }),
  ).toHaveLength(1);
  expect(
    screen.queryByRole("button", { name: "Details for Release checks" }),
  ).toBeNull();
  const link = screen.getByRole("link", { name: "Open buzz-app#1578" });
  expect(link.getAttribute("href")).toBe(
    "https://github.com/block/buzz-app/pull/1578",
  );
  expect(screen.queryByText("Show raw")).toBeNull();
});
