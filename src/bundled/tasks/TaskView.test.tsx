// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ChannelReachState } from "../../features/relay/channel-reach";
import type { ChannelSummary } from "../../features/relay/contracts";
import { PublishRejected } from "../../features/relay/outbox";
import type { RelaySession } from "../../features/relay/session";
import { TASK_TYPE, type Task, taskOf } from "./model";
import { TaskView } from "./TaskView";

afterEach(cleanup);

const viewer = "a".repeat(64);
const id = "11111111-1111-4111-8111-111111111111";
const home = "22222222-2222-4222-8222-222222222222";
const revision = (revisionId: string, title: string) => ({
  id: revisionId,
  pubkey: "b".repeat(64),
  sig: "",
  created_at: 5,
  kind: 45010,
  content: JSON.stringify({ version: 3 }),
  tags: [
    ["d", id],
    ["h", home],
    ["type", TASK_TYPE],
    ["title", title],
    ["creator", viewer],
  ],
});
const mine = taskOf(revision("d".repeat(64), "Fix the header")) as Task;
const theirs = revision("c".repeat(64), "Their title");

const project = "33333333-3333-4333-8333-333333333333";
const launch = "44444444-4444-4444-8444-444444444444";
const leo = "c".repeat(64);
const riley = "9".repeat(64);
/** The relay's answer for `home`: Leo can see it, Riley can't. */
const relayReaders = async (_channel: string, pubkeys: readonly string[]) =>
  new Map(pubkeys.map((key) => [key, key !== riley]));
const dm = "55555555-5555-4555-8555-555555555555";

type Answer = ChannelReachState;
const asking: Answer = { status: "loading" };
const opened = (post: boolean): Answer => ({
  status: "open",
  post,
  joined: false,
});

/** A session whose relay answers each place by name from `answers`, and
 * whose channel list holds only `home`. */
function setup(
  publish: () => Promise<string>,
  answers: Record<string, Answer> = { [home]: opened(true) },
  readers: RelaySession["channelReaders"] = relayReaders,
) {
  const signed: { tags: string[][] }[] = [];
  const channels: ChannelSummary[] = [
    { id: home, name: "design", channelType: "stream", viewerRole: "member" },
    { id: launch, name: "launch", channelType: "stream", readOnly: true },
  ];
  const profiles = new Map([
    [leo, { name: "Leo" }],
    [riley, { name: "Riley" }],
  ]);
  const list = { status: "ready", channels };
  const metadata = (d: string, name: string, extra: string[][] = []) => ({
    id: d.slice(0, 8).padEnd(64, "0"),
    pubkey: "e".repeat(64),
    sig: "",
    created_at: 1,
    kind: 39000,
    content: "",
    tags: [
      ["d", d],
      ["name", name],
      ["t", extra.find(([key]) => key === "t")?.[1] ?? "stream"],
      ["private"],
      ...extra.filter(([key]) => key !== "t"),
    ],
  });
  const session = {
    viewer,
    relayAuthor: "e".repeat(64),
    media: () => undefined,
    profiles: {
      snapshot: () => profiles,
      subscribe: () => () => {},
      ensure: async () => {},
    },
    channels: {
      ensureList: () => () => {},
      subscribeList: () => () => {},
      list: () => list,
      reach: (channel: string) => ({
        snapshot: () => answers[channel] ?? asking,
        subscribe: () => () => {},
        retry() {},
        release() {},
      }),
    },
    artifacts: { conversationId: async () => "f".repeat(8) },
    snapshotRead: vi.fn(async (filters: Record<string, unknown>[]) => {
      const filter = filters[0] ?? {};
      const kinds = filter.kinds as number[] | undefined;
      if (kinds?.includes(39000))
        return [
          metadata(home, "design", [["parent", project]]),
          metadata(project, "Payments"),
          metadata(launch, "launch"),
          metadata(dm, "", [["t", "dm"]]),
        ].filter((event) =>
          (filter["#d"] as string[]).includes(event.tags[0]?.[1] ?? ""),
        );
      if (kinds?.includes(39002))
        return [
          {
            ...metadata(home, ""),
            kind: 39002,
            tags: [
              ["d", home],
              ["p", viewer],
              ["p", leo],
              ["p", riley],
            ],
          },
        ].filter((event) =>
          (filter["#d"] as string[]).includes(event.tags[0]?.[1] ?? ""),
        );
      return kinds?.includes(45010) &&
        !String(filter["#type"] ?? "").includes("link")
        ? [theirs]
        : [];
    }),
    channelReaders: readers,
    configArtifactWriter: {
      sign: vi.fn(async (template: { tags: string[][] }) => {
        signed.push(template);
        return { ...template, id: "f".repeat(64), pubkey: viewer, sig: "" };
      }),
      publish: vi.fn(publish),
    },
  } as unknown as RelaySession;
  return { session, signed };
}

it("keeps the person's text on a conflict, then saves over the newer version", async () => {
  let refuse = true;
  const { session, signed } = setup(async () => {
    if (refuse) throw new PublishRejected("rejected", "conflict: stale prev");
    return "";
  });
  const onSaved = vi.fn();
  render(
    <TaskView
      session={session}
      task={mine}
      openConversation={() => {}}
      onSaved={onSaved}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText("Title"), {
    target: { value: "My title" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Someone else changed this task. Your text is kept.",
  );
  expect(screen.getByLabelText("Title")).toHaveValue("My title");
  refuse = false;
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await vi.waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(signed[1]?.tags).toContainEqual(["prev", theirs.id]);
  expect(signed[1]?.tags).toContainEqual(["title", "My title"]);
});

it("shows someone view-only there no edit controls, whatever their list says", () => {
  // Dana is a member of the task's home in her list, but the relay says she
  // can only read it.
  const { session } = setup(async () => "", { [home]: opened(false) });
  render(
    <TaskView
      session={session}
      task={mine}
      currentChat={launch}
      openConversation={() => {}}
      onSaved={() => {}}
    />,
  );
  for (const name of ["Edit", "Move…", "More", "Link this chat", "Unlink"])
    expect(screen.queryByRole("button", { name })).toBeNull();
  expect(screen.queryByLabelText("Status")).toBeNull();
  // Comments say it once, where they'd try to act.
  expect(screen.queryByText("Read-only access")).toBeNull();
});

it("shows neither edit controls nor read-only while the relay is asked", () => {
  const { session } = setup(async () => "", {});
  render(
    <TaskView
      session={session}
      task={mine}
      openConversation={() => {}}
      onSaved={() => {}}
    />,
  );
  expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  expect(screen.queryByText("Read-only access")).toBeNull();
});

it("lets someone with access edit where they haven't joined", () => {
  // Wes reads #launch through its project and may post there; it isn't in
  // his list as joined.
  const task = { ...mine, home: launch };
  const { session } = setup(async () => "", { [launch]: opened(true) });
  render(
    <TaskView
      session={session}
      task={task}
      openConversation={() => {}}
      onSaved={() => {}}
    />,
  );
  expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
  expect(screen.getByLabelText("Status")).toBeInTheDocument();
});

it("names projects and channels by one rule", async () => {
  const { session } = setup(async () => "");
  render(
    <TaskView
      session={session}
      task={mine}
      openConversation={() => {}}
      onSaved={() => {}}
    />,
  );
  expect(await screen.findByText("Payments · #design")).toBeInTheDocument();
});

it("creates a new task where the relay says the viewer can post, posting nothing", async () => {
  const { session, signed } = setup(async () => "");
  const onSaved = vi.fn();
  render(
    <TaskView
      session={session}
      task={undefined}
      home={home}
      openConversation={() => {}}
      onSaved={onSaved}
    />,
  );
  fireEvent.change(screen.getByLabelText("Title"), {
    target: { value: "From this chat" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create task" }));
  await vi.waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(signed).toHaveLength(1);
  expect(signed[0]?.tags).toContainEqual(["h", home]);
  expect(signed[0]?.tags).toContainEqual(["op", "create"]);
});

it("won't create a task where the relay says the viewer can't post", async () => {
  const { session, signed } = setup(async () => "", {
    [launch]: opened(false),
  });
  render(
    <TaskView
      session={session}
      task={undefined}
      home={launch}
      openConversation={() => {}}
      onSaved={() => {}}
    />,
  );
  fireEvent.change(screen.getByLabelText("Title"), {
    target: { value: "Nope" },
  });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "You can’t post in #launch",
  );
  fireEvent.click(screen.getByRole("button", { name: "Create task" }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(signed).toHaveLength(0);
});

it("starts a new task from a DM with no place, and won't create until one is picked", async () => {
  const { session, signed } = setup(async () => "", {
    [home]: opened(true),
    [dm]: opened(true),
  });
  render(
    <TaskView
      session={session}
      task={undefined}
      home={dm}
      openConversation={() => {}}
      onSaved={() => {}}
    />,
  );
  fireEvent.change(screen.getByLabelText("Title"), {
    target: { value: "From a DM" },
  });
  const create = screen.getByRole("button", { name: "Create task" });
  await vi.waitFor(() => expect(create).toBeDisabled());
  expect(screen.getByText("Choose a place")).toBeInTheDocument();
  fireEvent.click(create);
  expect(signed).toHaveLength(0);
});

const assignedTo = (...people: string[]) =>
  taskOf({
    ...revision("d".repeat(64), "Fix the header"),
    tags: [
      ...revision("d".repeat(64), "Fix the header").tags,
      ...people.map((key) => ["assignee", key]),
    ],
  }) as Task;

it("names someone the relay says lost access, and unassigns only them", async () => {
  const { session, signed } = setup(async () => "");
  const onSaved = vi.fn();
  render(
    <TaskView
      session={session}
      task={assignedTo(leo, riley)}
      openConversation={() => {}}
      onSaved={onSaved}
    />,
  );
  expect(
    await screen.findByText("Riley can’t see this task anymore."),
  ).toBeInTheDocument();
  expect(screen.queryByText(/Leo can’t see/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Unassign Riley" }));
  await vi.waitFor(() => expect(onSaved).toHaveBeenCalled());
  const tags = signed[0]?.tags ?? [];
  expect(tags.filter(([name]) => name === "assignee")).toEqual([
    ["assignee", leo],
  ]);
});

it("offers to unassign several who lost access all at once", async () => {
  const { session } = setup(
    async () => "",
    undefined,
    async (_, pubkeys) => new Map(pubkeys.map((key) => [key, false])),
  );
  render(
    <TaskView
      session={session}
      task={assignedTo(leo, riley)}
      openConversation={() => {}}
      onSaved={() => {}}
    />,
  );
  expect(
    await screen.findByText("Leo and Riley can’t see this task anymore."),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Unassign all" }),
  ).toBeInTheDocument();
});

it("names someone who lost access to a view-only reader, with no way to unassign", async () => {
  const { session } = setup(async () => "", { [home]: opened(false) });
  render(
    <TaskView
      session={session}
      task={assignedTo(riley)}
      openConversation={() => {}}
      onSaved={() => {}}
    />,
  );
  expect(
    await screen.findByText("Riley can’t see this task anymore."),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /Unassign/ }),
  ).not.toBeInTheDocument();
});

it("offers only people the relay says can see the task", async () => {
  const { session } = setup(async () => "");
  render(
    <TaskView
      session={session}
      task={mine}
      openConversation={() => {}}
      onSaved={() => {}}
    />,
  );
  fireEvent.click(await screen.findByRole("combobox", { name: "Assignees" }));
  expect(await screen.findByRole("option", { name: /Leo/ })).toBeVisible();
  expect(screen.queryByRole("option", { name: /Riley/ })).toBeNull();
});

it("says nothing about access, and offers everyone, when the relay can't say", async () => {
  const { session } = setup(
    async () => "",
    undefined,
    async () => {
      throw new Error("not-allowed");
    },
  );
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  render(
    <TaskView
      session={session}
      task={assignedTo(riley)}
      openConversation={() => {}}
      onSaved={() => {}}
    />,
  );
  fireEvent.click(await screen.findByRole("combobox", { name: "Assignees" }));
  expect(await screen.findByRole("option", { name: /Leo/ })).toBeVisible();
  expect(screen.queryByText(/can’t see/)).toBeNull();
  warn.mockRestore();
});

it("unassigns on a move only those the relay says can't see the destination", async () => {
  const { session, signed } = setup(async () => "", {
    [home]: opened(true),
    [launch]: opened(true),
  });
  const onSaved = vi.fn();
  render(
    <TaskView
      session={session}
      task={assignedTo(leo, riley)}
      openConversation={() => {}}
      onSaved={onSaved}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Move…" }));
  fireEvent.click(await screen.findByRole("combobox", { name: "Move to" }));
  fireEvent.click(await screen.findByRole("option", { name: /launch/ }));
  expect(
    await screen.findByText(/Riley can’t see #launch and will be unassigned/),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Move" }));
  await vi.waitFor(() => expect(signed).toHaveLength(1));
  expect(
    (signed[0]?.tags ?? []).filter(([name]) => name === "assignee"),
  ).toEqual([["assignee", leo]]);
});
