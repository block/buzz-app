// @vitest-environment jsdom
import * as React from "react";
import userEvent from "@testing-library/user-event";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Context } from "../../../plugins/author";
import {
  createRecipeForm,
  recipeWatch,
  delivery,
  resolveDelivery,
  channelId,
  conversationLink,
  type Recipe,
} from "./recipes";
afterEach(cleanup);
async function choose(label: string, option: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name: option }));
}
const recipe: Recipe = {
  kind: "schedule",
  instructions: "Check the release",
  pr: "",
  command: "",
  when: "2030-01-01T00:10:00Z",
  repeat: "",
  count: "",
  end: "",
  channel: "report",
};
const now = Date.parse("2030-01-01T00:00:00Z") / 1000;
it("schedules one run by default and preserves first run when repetition is added", () => {
  const single = recipeWatch(recipe, "task", now);
  expect(single).toMatchObject({
    type: "timer",
    interval_secs: 600,
    armed_at: now,
    max_occurrences: 1,
    expires_at: null,
    channel: "report",
  });
  const repeating = recipeWatch(
    { ...recipe, repeat: "60", count: "3", end: "2030-01-02T00:00:00Z" },
    "task",
    now,
  );
  expect(repeating).toMatchObject({
    interval_secs: 3600,
    armed_at: now + 600 - 3600,
    max_occurrences: 3,
    expires_at: now + 86400,
  });
});
it("rejects invalid schedules and source configurations before saving", () => {
  for (const change of [
    { when: "invalid" },
    { when: "2020-01-01" },
    { repeat: "-1" },
    { repeat: "2", count: "1.5" },
    { end: recipe.when },
  ])
    expect(() => recipeWatch({ ...recipe, ...change }, "task", now)).toThrow();
  expect(() =>
    recipeWatch(
      { ...recipe, kind: "pr", pr: "https://example.com/a/b/pull/1" },
      "task",
      now,
    ),
  ).toThrow();
  expect(() =>
    recipeWatch(
      { ...recipe, kind: "command", command: '["echo", 1]' },
      "task",
      now,
    ),
  ).toThrow();
  expect(() =>
    recipeWatch({ ...recipe, instructions: " " }, "task", now),
  ).toThrow();
});
it("creates source configurations for the existing providers", () => {
  expect(
    recipeWatch(
      {
        ...recipe,
        kind: "pr",
        pr: "https://github.com/example/project/pull/42/",
      },
      "task",
      now,
    ),
  ).toMatchObject({
    type: "source",
    provider: "attention/github-pr",
    config: { pr: "https://github.com/example/project/pull/42" },
  });
  expect(
    recipeWatch(
      {
        ...recipe,
        kind: "command",
        command: '["program", "literal argument"]',
      },
      "task",
      now,
    ),
  ).toMatchObject({
    type: "source",
    provider: "attention/command",
    config: { command: ["program", "literal argument"] },
  });
});
it("preserves a failed draft and saves new Interest instructions on retry", async () => {
  const save = vi
    .fn()
    .mockRejectedValueOnce(new Error("Save failed"))
    .mockResolvedValueOnce(undefined);
  const close = vi.fn();
  const Form = createRecipeForm({
    react: React,
    agents: { save, snapshot: () => ({ running: [{ key: "membership-a" }] }) },
  } as unknown as Context);
  render(
    React.createElement(Form, {
      running: [{ key: "membership-a", pubkey: "a", name: "Ada" }] as never,
      channels: [],
      close,
    }),
  );
  await choose("Agent", "Ada");
  fireEvent.change(screen.getByLabelText("Interest instructions"), {
    target: { value: "Review failures" },
  });
  fireEvent.change(screen.getByLabelText("Pull request URL"), {
    target: { value: "https://github.com/example/project/pull/42" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create watch" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toBe("Save failed"),
  );
  expect(
    (screen.getByLabelText("Interest instructions") as HTMLTextAreaElement)
      .value,
  ).toBe("Review failures");
  expect(close).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Create watch" }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  const [key, patch] = save.mock.calls[1] ?? [];
  expect(key).toBe("membership-a");
  expect(patch.attentionEnabled).toBe(true);
  const values = Object.values(patch.attention);
  expect(values).toHaveLength(2);
  expect(values).toContainEqual({
    type: "interest",
    instructions: "Review failures",
  });
  expect(
    values.find((value) => (value as { type: string }).type === "source"),
  ).toHaveProperty("interest_id");
  expect(values).toContainEqual(
    expect.objectContaining({ provider: "attention/github-pr" }),
  );
});

const channel = "11111111-1111-1111-1111-111111111111";
const other = "22222222-2222-2222-2222-222222222222";
const channels = [{ id: channel, name: "Release planning" }];
const root = "a".repeat(64);
it("resolves delivery names and links, infers thread channels, and rejects conflicts", () => {
  expect(delivery("", "", channels)).toEqual({});
  expect(delivery("#release planning", "", channels)).toEqual({ channel });
  expect(delivery(`buzz://channel/${channel}`, "", channels)).toEqual({
    channel,
  });
  expect(
    delivery(
      "",
      `buzz://message?channel=${channel}&id=${"b".repeat(64)}&thread=${root}`,
      channels,
    ),
  ).toEqual({ channel, root });
  expect(() =>
    delivery(
      other,
      `buzz://message?channel=${channel}&id=${root}&thread=${root}`,
      channels,
    ),
  ).toThrow(/different channel/);
  expect(() =>
    channelId("Release planning", [
      ...channels,
      { id: other, name: "Release planning" },
    ]),
  ).toThrow(/unique/);
  expect(conversationLink("https://example.com")).toBeNull();
  expect(
    conversationLink(`buzz://message?channel=${channel}&id=${root}&thread=bad`),
  ).toBeNull();
});
it("creates deterministic event selectors with independent delivery", () => {
  expect(
    recipeWatch(
      { ...recipe, kind: "event", keywords: "failed\n[release]" },
      "task",
      now,
    ),
  ).toMatchObject({ keywords: ["failed", "[release]"] });
  const value = recipeWatch(
    {
      ...recipe,
      kind: "event",
      channel: other,
      thread: root,
      listen: channel,
      kinds: "9, 7 9",
      authors: "b".repeat(64),
      replies: "top",
      tags: '{"t":["release"]}',
    },
    "task",
    now,
  );
  expect(value).toMatchObject({
    type: "event",
    interest_id: "task",
    since: now,
    channel: other,
    root,
    channels: [channel],
    kinds: [9, 7],
    authors: ["b".repeat(64)],
    is_reply: false,
    tags: { t: ["release"] },
  });
  expect(value).not.toHaveProperty("prompt");
  expect(
    recipeWatch(
      { ...recipe, kind: "event", interest: "release", kinds: "all" },
      "task",
      now,
    ),
  ).toMatchObject({ interest_id: "release", kinds: [], channels: "all" });
  expect(() =>
    recipeWatch({ ...recipe, kind: "event", authors: "bad" }, "task", now),
  ).toThrow(/Authors/);
  expect(() =>
    recipeWatch(
      { ...recipe, kind: "event", authors: root, exclude: root },
      "task",
      now,
    ),
  ).toThrow(/either/);
  expect(() =>
    recipeWatch({ ...recipe, kind: "event", tags: "[]" }, "task", now),
  ).toThrow(/JSON object/);
});

it("autofills a thread channel and saves event selectors with an existing shared Interest", async () => {
  const save = vi.fn().mockResolvedValue(undefined),
    close = vi.fn();
  const Form = createRecipeForm({
    react: React,
    agents: { save, snapshot: () => ({ running: [{ key: "membership-a" }] }) },
  } as unknown as Context);
  render(
    React.createElement(Form, {
      running: [
        {
          key: "membership-a",
          pubkey: "a",
          name: "Ada",
          attention: {
            "interest/release": {
              value: { type: "interest", instructions: "Keep releases moving" },
            },
          },
        },
      ] as never,
      channels,
      close,
    }),
  );
  await choose("Agent", "Ada");
  await choose("Recipe", "Event filter");
  fireEvent.change(screen.getByLabelText("Interest instructions"), {
    target: { value: "Report blockers" },
  });
  fireEvent.change(
    screen.getByLabelText("Message keywords (one per line, optional)"),
    { target: { value: "failed\n[release]" } },
  );
  expect(screen.queryByLabelText("Relevance question (optional)")).toBeNull();
  await choose("Interest", "release");
  fireEvent.change(
    screen.getByLabelText(
      "Listening channels (one name or link per line, optional)",
    ),
    { target: { value: "Release planning" } },
  );
  fireEvent.change(screen.getByLabelText("Thread link (optional)"), {
    target: {
      value: `buzz://message?channel=${channel}&id=${root}&thread=${root}`,
    },
  });
  expect(
    (screen.getByLabelText("Channel (optional)") as HTMLInputElement).value,
  ).toBe("Release planning");
  fireEvent.click(screen.getByRole("button", { name: "Create watch" }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  const values = Object.values(save.mock.calls[0]?.[1].attention ?? {});
  expect(values).toHaveLength(1);
  expect(values[0]).toMatchObject({
    type: "event",
    interest_id: "release",
    channel,
    root,
    channels: [channel],
    keywords: ["failed", "[release]"],
  });
  expect(values[0]).not.toHaveProperty("prompt");
  expect(screen.queryByLabelText("Interest instructions")).toBeNull();
});

it("resolves ambiguous message links against signed message metadata before saving a root", async () => {
  const reply = "b".repeat(64);
  const read = vi.fn().mockResolvedValue([
    {
      id: reply,
      tags: [
        ["h", channel],
        ["e", root, "", "root"],
        ["e", root, "", "reply"],
      ],
    },
  ]);
  expect(
    await resolveDelivery(
      "",
      `buzz://message?channel=${channel}&id=${reply}`,
      channels,
      read,
    ),
  ).toEqual({ channel, root });
  expect(
    await resolveDelivery(
      "",
      `buzz://channel/${channel}/${reply}`,
      channels,
      read,
    ),
  ).toEqual({ channel, root });
  await expect(
    resolveDelivery(
      "",
      `buzz://message?channel=${channel}&id=${reply}`,
      channels,
    ),
  ).rejects.toThrow(/Connect/);
  await expect(
    resolveDelivery(
      "",
      `buzz://message?channel=${other}&id=${reply}`,
      channels,
      read,
    ),
  ).rejects.toThrow(/unavailable/);
  read.mockResolvedValue([{ id: root, tags: [["h", channel]] }]);
  expect(
    await resolveDelivery(
      "",
      `buzz://message?channel=${channel}&id=${root}`,
      channels,
      read,
    ),
  ).toEqual({ channel, root });
});

it.each(["community", "membership"])(
  "rejects a pending recipe after its %s changes",
  async (change) => {
    const save = vi.fn(),
      close = vi.fn();
    let finish!: (events: { id: string; tags: string[][] }[]) => void;
    const read = vi.fn(
      () =>
        new Promise<{ id: string; tags: string[][] }[]>((resolve) => {
          finish = resolve;
        }),
    );
    let running = [{ key: "membership-a", pubkey: "a", name: "Ada" }];
    let connection = {
      status: "ready",
      scope: "community-a",
      session: { read },
    };
    const Form = createRecipeForm({
      agents: { save, snapshot: () => ({ running }) },
      relay: { snapshot: () => connection },
    } as unknown as Context);
    const props = () => ({ running: running as never, channels, close });
    const view = render(React.createElement(Form, props()));
    await choose("Agent", "Ada");
    fireEvent.change(screen.getByLabelText("Interest instructions"), {
      target: { value: "Report failures" },
    });
    fireEvent.change(screen.getByLabelText("Pull request URL"), {
      target: { value: "https://github.com/example/project/pull/42" },
    });
    fireEvent.change(screen.getByLabelText("Thread link (optional)"), {
      target: { value: `buzz://message?channel=${channel}&id=${root}` },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create watch" }));
    await waitFor(() => expect(read).toHaveBeenCalledOnce());
    if (change === "community")
      connection = { ...connection, scope: "community-b" };
    else running = [];
    view.rerender(React.createElement(Form, props()));
    finish([{ id: root, tags: [["h", channel]] }]);
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(/changed/),
    );
    expect(save).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  },
);
