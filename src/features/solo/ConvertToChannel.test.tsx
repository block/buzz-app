// @vitest-environment jsdom
import type { AgentChoicesSnapshot } from "../agents/choices";
import "@testing-library/jest-dom/vitest";
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
import userEvent from "@testing-library/user-event";
import { finalizeEvent, getPublicKey, type EventTemplate } from "nostr-tools";
import { createChannelDetails } from "../relay/channel-details";
import { createRelaySession } from "../relay/session";
import { PublishRejected } from "../relay/outbox";
import type { Profile } from "../relay/contracts";
import { SOLO_LABEL } from "./labels";
import { chatConversion, conversionLabel } from "./conversion";
import { ConvertToChannel, canConvertToChannel } from "./ConvertToChannel";

const id = "11111111-1111-4111-8111-111111111111";
const key = new Uint8Array(32).fill(2),
  relayKey = new Uint8Array(32).fill(3);
const viewer = getPublicKey(key),
  relayAuthor = getPublicKey(relayKey);
const dispose: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const close of dispose.splice(0)) close();
});
function setup(
  solo = true,
  initialVisibility: "private" | "public" = "private",
  initialJoinRole: "member" | "guest" | undefined = undefined,
  members?: string[],
  profilesLoaded = true,
  /** Profiles and a complete inventory arrive only through the loads the
   * component starts (profiles.ensure, agentChoices.retain). */
  onDemand = false,
) {
  let clock = 100,
    role = "owner",
    name = "Original",
    visibility = initialVisibility,
    joinRole = initialJoinRole;
  let labels = solo ? [SOLO_LABEL, "work"] : ["work"];
  const record = (kind: number, tags: string[][]) =>
    finalizeEvent(
      { kind, tags: [["d", id], ...tags], content: "", created_at: clock },
      relayKey,
    );
  const metadata = () =>
    record(39000, [
      ["name", name],
      ["about", "Notes"],
      ["t", "stream"],
      ...labels.map((label) => ["t", label]),
      [visibility],
      ...(joinRole ? [["join_role", joinRole]] : []),
      ["ttl", "86400"],
    ]);
  const read = vi.fn(async () => [
    metadata(),
    record(39001, role === "member" ? [] : [["p", viewer, role]]),
    record(39002, [["p", viewer, "", role]]),
  ]);
  const sign = vi.fn(async (template: EventTemplate) =>
    finalizeEvent(structuredClone(template), key),
  );
  const publish = vi.fn(async (event: import("../relay/events").RelayEvent) => {
    const written = event.tags.flatMap(([tag, value]) =>
      tag === "t" && value !== undefined ? [value] : [],
    );
    if (written.length) labels = written.filter(Boolean);
    const choice = event.tags.find(([tag]) => tag === "visibility")?.[1];
    if (choice) visibility = choice === "open" ? "public" : "private";
    const admission = event.tags.find(([tag]) => tag === "join_role")?.[1];
    if (admission === "member" || admission === "guest") joinRole = admission;
    clock++;
  });
  const details = createChannelDetails({
    reader: { read },
    writer: { sign, publish },
    viewer,
    relayAuthor,
    labels: true,
    canAccess: () => true,
    acceptDiscovery: () => {},
  });
  const owner = createRelaySession(null);
  dispose.push(details.dispose, owner.dispose);
  const projects = (assignments: Record<string, string>) => ({
    status: "ready" as const,
    data: {
      sections: [{ id: "g", name: "Project", order: 0 }],
      assignments,
      starred: [],
      muted: [],
    },
  });
  const filedProjects = projects({ [id]: "g" });
  const unfiledProjects = projects({});
  let filed = true;
  const unfile = vi.fn(async (_id: string, _sectionId?: string) => {
    filed = false;
    return { sections: [], assignments: {}, starred: [], muted: [] };
  });
  const projectsRefresh = vi.fn(async () => {});
  const listed = members && {
    ...owner.session.channels.list(),
    channels: [{ id, name, channelType: "solo" as const, members }],
  };
  const channels = listed
    ? { ...owner.session.channels, list: () => listed }
    : owner.session.channels;
  // Every listed member other than the viewer has a person's loaded profile.
  const others = (members ?? []).filter((m) => m !== viewer);
  const person = (pubkey: string): [string, Profile] => [
    pubkey,
    { name: "Morgan" },
  ];
  let people = new Map<string, Profile>(
    profilesLoaded && !onDemand ? others.map(person) : [],
  );
  const owners = new Map<string, string>();
  const profileListeners = new Set<() => void>();
  let inventory: AgentChoicesSnapshot = Object.freeze({
    ...owner.session.agentChoices.snapshot(),
    identities: [],
    complete: !onDemand,
    pending: false,
  });
  const inventoryListeners = new Set<() => void>();
  const session = {
    ...owner.session,
    ...(members && {
      viewer,
      profiles: {
        ...owner.session.profiles,
        snapshot: () => people,
        owner: (pubkey: string) => owners.get(pubkey),
        subscribe: (listener: () => void) => {
          profileListeners.add(listener);
          return () => profileListeners.delete(listener);
        },
        ensure: async (keys: readonly string[]) => {
          const missing = keys.filter(
            (key) => onDemand && others.includes(key) && !people.has(key),
          );
          if (!missing.length) return;
          people = new Map([...people, ...missing.map(person)]);
          for (const listener of profileListeners) listener();
        },
      },
      agentChoices: {
        ...owner.session.agentChoices,
        snapshot: () => inventory,
        subscribe: (listener: () => void) => {
          inventoryListeners.add(listener);
          return () => inventoryListeners.delete(listener);
        },
        retain: () => {
          if (onDemand && !inventory.complete) {
            inventory = Object.freeze({ ...inventory, complete: true });
            for (const listener of inventoryListeners) listener();
          }
          return () => {};
        },
        ensure: () => {},
      },
    }),
    channels,
    channelDetails: details.capability,
    sidebarPreferences: {
      ...owner.session.sidebarPreferences,
      snapshot: () => (filed ? filedProjects : unfiledProjects),
      refresh: projectsRefresh,
      assign: unfile,
    },
  };
  const close = vi.fn();
  const converted = vi.fn();
  const visit = new AbortController();
  const mounted = render(
    <ConvertToChannel
      session={session}
      id={id}
      signal={visit.signal}
      close={close}
      onConverted={converted}
    />,
  );
  return {
    session,
    loadProfiles: (profile?: Profile) => {
      people = new Map(
        others.map((pubkey) => (profile ? [pubkey, profile] : person(pubkey))),
      );
      for (const listener of profileListeners) listener();
    },
    /** Verification lands without a new profile snapshot. */
    verifyOwner: (pubkey: string, by: string) => {
      owners.set(pubkey, by);
      for (const listener of profileListeners) listener();
    },
    setInventoryComplete: (complete: boolean) => {
      inventory = Object.freeze({ ...inventory, complete });
      for (const listener of inventoryListeners) listener();
    },
    close,
    convertedCallback: converted,
    unfile,
    projectsRefresh,
    read,
    sign,
    publish,
    visit,
    mounted,
    details,
    authority: (next: string) => {
      role = next;
    },
    rename: (next = "Changed") => {
      name = next;
      clock++;
    },
    admission: (next: "member" | "guest") => {
      joinRole = next;
      clock++;
    },
    converted: (
      next: "private" | "public" = "private",
      admission: "member" | "guest" | undefined = next === "public"
        ? "member"
        : joinRole,
    ) => {
      labels = labels.filter((label) => label !== SOLO_LABEL);
      visibility = next;
      joinRole = admission;
      clock++;
    },
  };
}
const confirm = () =>
  screen.getByRole("button", { name: "Convert to channel" });
const accessControl = () =>
  screen.getByRole("combobox", { name: "General access" });
const nameField = () => screen.getByRole("textbox", { name: "Name" });
async function selectAccess(label: string) {
  const user = userEvent.setup();
  await user.click(accessControl());
  await user.click(await screen.findByRole("option", { name: label }));
}
async function ready() {
  await waitFor(() => expect(confirm()).toBeEnabled());
}
it("starts on Cancel so Enter does not convert or publish", async () => {
  const h = setup();
  await ready();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus(),
  );
  await userEvent.setup().keyboard("{Enter}");
  await waitFor(() => expect(h.close).toHaveBeenCalledOnce());
  expect(h.publish).not.toHaveBeenCalled();
  expect(h.unfile).not.toHaveBeenCalled();
});

it("preselects View only and preserves Guest admission when converting a view-only Solo chat", async () => {
  const h = setup(true, "public", "guest");
  await ready();
  expect(accessControl()).toHaveTextContent("View only");
  fireEvent.click(confirm());
  await waitFor(() => expect(h.close).toHaveBeenCalledOnce());
  expect(h.publish).toHaveBeenCalledOnce();
  expect(h.sign.mock.calls[0]?.[0].tags).not.toContainEqual([
    "visibility",
    "private",
  ]);
  expect(await h.details.capability.load(id)).toMatchObject({
    visibility: "public",
    joinRole: "guest",
    labels: ["work"],
    ttlSeconds: 86400,
  });
});
it.each(["private", "public"])(
  "converts through signed kind 9002 with explicit %s visibility and unchanged TTL",
  async (visibility) => {
    const h = setup();
    await ready();
    expect(accessControl()).toHaveTextContent("Private");
    // The chat's title is the default name.
    expect(nameField()).toHaveValue("Original");
    const user = userEvent.setup();
    await user.click(accessControl());
    expect(
      await screen.findByRole("option", { name: "Public" }),
    ).toHaveAccessibleDescription("Anyone in the community can participate.");
    await user.keyboard("{Escape}");
    if (visibility === "public") {
      await selectAccess("Public");
    }
    expect(h.sign).not.toHaveBeenCalled();
    fireEvent.click(confirm());
    await waitFor(() => expect(h.close).toHaveBeenCalledOnce());
    expect(h.publish).toHaveBeenCalledOnce();
    expect(h.unfile).not.toHaveBeenCalled();
    expect(h.session.sidebarPreferences.snapshot().data?.assignments[id]).toBe(
      "g",
    );
    expect(h.convertedCallback).toHaveBeenCalledOnce();
    expect(chatConversion(h.session, id)).toBeUndefined();
    const event = h.sign.mock.calls[0]?.[0];
    expect(event?.kind).toBe(9002);
    expect(event?.tags).toEqual([
      ["h", id],
      ["name", "Original"],
      ["about", "Notes"],
      ...(visibility === "public" ? [["visibility", "open"]] : []),
      ["t", "work"],
    ]);
    const saved = await h.details.capability.load(id);
    expect(saved).toMatchObject({
      name: "Original",
      description: "Notes",
      visibility,
      ttlSeconds: 86400,
      labels: ["work"],
    });
  },
);

const policies = [
  { label: "Private", visibility: "private", joinRole: "guest" },
  { label: "View only", visibility: "public", joinRole: "guest" },
  { label: "Public", visibility: "public", joinRole: "member" },
] as const;
it.each(policies.flatMap((from) => policies.map((to) => ({ from, to }))))(
  "converts $from.label → $to.label with the selected admission policy",
  async ({ from, to }) => {
    const h = setup(true, from.visibility, from.joinRole);
    await ready();
    expect(accessControl()).toHaveTextContent(from.label);
    const user = userEvent.setup();
    await user.click(accessControl());
    expect(await screen.findAllByRole("option")).toHaveLength(3);
    expect(
      screen.getByRole("option", { name: "View only" }),
    ).toHaveAccessibleDescription("Anyone in the community can read.");
    await user.click(screen.getByRole("option", { name: to.label }));
    const disclosure = screen.queryByText(
      "Everyone in this community will be able to read this chat’s full history and Canvas, including its workspace folders and agent instructions.",
      { exact: false },
    );
    if (from.visibility === "private" && to.visibility === "public") {
      expect(disclosure).toBeVisible();
      expect(screen.getByRole("dialog")).toHaveAccessibleDescription(
        disclosure?.textContent,
      );
    } else expect(disclosure).not.toBeInTheDocument();
    if (from.visibility === "public" && to.visibility === "private") {
      expect(screen.getByRole("dialog")).toHaveAccessibleDescription(
        from.joinRole === "guest"
          ? "People who joined while it was View only are members and keep reading until you remove them in People."
          : "People who already joined remain members and keep their access until you remove them in People.",
      );
    }
    expect(h.publish).not.toHaveBeenCalled();
    fireEvent.click(confirm());
    await waitFor(() => expect(h.close).toHaveBeenCalledOnce());
    expect(h.publish).toHaveBeenCalledOnce();
    expect(await h.details.capability.load(id)).toMatchObject({
      visibility: to.visibility,
      joinRole: to.visibility === "private" ? from.joinRole : to.joinRole,
      labels: ["work"],
      ttlSeconds: 86400,
    });
  },
);

it("preselects Public when the open chat has the default Member admission", async () => {
  setup(true, "public", undefined);
  await ready();
  expect(accessControl()).toHaveTextContent("Public");
});

it("retires superseded View-only recovery after Finish rejects changed admission and reload/remount", async () => {
  const h = setup(true, "public", "member");
  await ready();
  await selectAccess("View only");
  h.publish.mockRejectedValueOnce(new Error("lost acknowledgment"));
  fireEvent.click(confirm());
  await screen.findByRole("alert");
  h.mounted.unmount();
  h.converted("public", "guest");
  await h.session.channelDetails.check(id);
  render(<ConvertToChannel session={h.session} id={id} close={h.close} />);
  const finish = await screen.findByRole("button", {
    name: "Finish conversion",
  });
  expect(accessControl()).toHaveTextContent("View only");
  h.admission("member");
  fireEvent.click(finish);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "settings changed",
  );
  expect(h.unfile).not.toHaveBeenCalled();
  expect(chatConversion(h.session, id)).toBeUndefined();
  fireEvent.click(screen.getByRole("button", { name: "Reload chat details" }));
  await screen.findByText("Only a Solo chat can be converted.");
  expect(
    screen.queryByRole("button", { name: "Finish conversion" }),
  ).toBeNull();
  expect(confirm()).toBeDisabled();
  cleanup();
  render(<ConvertToChannel session={h.session} id={id} close={h.close} />);
  await screen.findByText("Only a Solo chat can be converted.");
  expect(
    screen.queryByRole("button", { name: "Finish conversion" }),
  ).toBeNull();
  expect(conversionLabel(h.session, id)).toBe("Convert to channel");
  expect(
    canConvertToChannel(h.session, {
      id,
      name: "Original",
      channelType: "stream",
    }),
  ).toBe(false);
  expect(h.close).not.toHaveBeenCalled();
  expect(h.unfile).not.toHaveBeenCalled();
  expect(h.publish).toHaveBeenCalledOnce();
});

it("does not offer completion when the confirmed conversion has different admission", async () => {
  const h = setup(true, "public", "guest");
  await ready();
  h.publish.mockRejectedValueOnce(new Error("lost acknowledgment"));
  fireEvent.click(confirm());
  await screen.findByRole("alert");
  h.mounted.unmount();
  h.converted("public", "guest");
  await h.session.channelDetails.check(id);
  h.admission("member");
  render(<ConvertToChannel session={h.session} id={id} close={h.close} />);
  await screen.findByText("Only a Solo chat can be converted.");
  expect(
    screen.queryByRole("button", { name: "Finish conversion" }),
  ).toBeNull();
  expect(confirm()).toBeDisabled();
  expect(h.unfile).not.toHaveBeenCalled();
  expect(chatConversion(h.session, id)).toBeUndefined();
});

it("keeps Finish recovery after a transient read failure and completes without republishing", async () => {
  const h = setup(true, "public", "guest");
  await ready();
  h.publish.mockRejectedValueOnce(new Error("lost acknowledgment"));
  fireEvent.click(confirm());
  await screen.findByRole("alert");
  h.mounted.unmount();
  h.converted("public", "guest");
  await h.session.channelDetails.check(id);
  render(<ConvertToChannel session={h.session} id={id} close={h.close} />);
  const finish = await screen.findByRole("button", {
    name: "Finish conversion",
  });
  const receipt = chatConversion(h.session, id);
  h.read.mockRejectedValueOnce(new Error("Details unavailable"));
  fireEvent.click(finish);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Details unavailable",
  );
  expect(chatConversion(h.session, id)).toBe(receipt);
  await waitFor(() => expect(finish).toBeEnabled());
  fireEvent.click(finish);
  await waitFor(() => expect(h.close).toHaveBeenCalledOnce());
  expect(h.publish).toHaveBeenCalledOnce();
  expect(h.unfile).not.toHaveBeenCalled();
});
it.each(["authority", "conflict"])(
  "fresh %s prevents conversion and reload explicitly recovers",
  async (change) => {
    const h = setup();
    await ready();
    if (change === "authority") h.authority("member");
    else h.rename();
    fireEvent.click(confirm());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      change === "authority" ? "permission" : "changed",
    );
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.close).not.toHaveBeenCalled();
    h.authority("admin");
    fireEvent.click(
      screen.getByRole("button", { name: "Reload chat details" }),
    );
    await ready();
    fireEvent.click(confirm());
    await waitFor(() => expect(h.close).toHaveBeenCalledOnce());
    expect(h.publish).toHaveBeenCalledOnce();
    expect(h.sign.mock.calls[0]?.[0].tags).toContainEqual(["t", "work"]);
    expect((await h.details.capability.load(id)).labels).toEqual(["work"]);
  },
);
it.each([
  { visibility: "private", failedRead: false },
  { visibility: "public", failedRead: true },
] as const)(
  "unknown $visibility conversion checks status without resending after remount, failed initial read=$failedRead",
  async ({ visibility, failedRead }) => {
    const h = setup();
    h.publish.mockRejectedValueOnce(new Error("lost acknowledgement"));
    await ready();
    if (visibility === "public") await selectAccess("Public");
    fireEvent.click(confirm());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "may have been saved",
    );
    h.mounted.unmount();
    const pending = h.details.capability.snapshot(id);
    if (failedRead)
      h.read.mockRejectedValueOnce(new Error("Details unavailable"));
    render(<ConvertToChannel session={h.session} id={id} close={h.close} />);
    if (failedRead) {
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Details unavailable",
      );
      expect(confirm()).toBeDisabled();
      expect(screen.queryByRole("button", { name: "Check status" })).toBeNull();
      expect(h.details.capability.snapshot(id)).toBe(pending);
      expect(accessControl()).toHaveTextContent(
        visibility === "public" ? "Public" : "Private",
      );
      expect(accessControl()).toBeDisabled();
      fireEvent.click(
        screen.getByRole("button", { name: "Reload chat details" }),
      );
    }
    const check = await screen.findByRole("button", { name: "Check status" });
    expect(h.details.capability.snapshot(id)).toBe(pending);
    expect(accessControl()).toHaveTextContent(
      visibility === "public" ? "Public" : "Private",
    );
    expect(accessControl()).toBeDisabled();
    fireEvent.keyDown(accessControl(), { key: "ArrowDown" });
    expect(accessControl()).toHaveTextContent(
      visibility === "public" ? "Public" : "Private",
    );
    expect(h.sign).toHaveBeenCalledOnce();
    expect(h.publish).toHaveBeenCalledOnce();
    fireEvent.click(check);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "may have been saved",
    );
    expect(h.publish).toHaveBeenCalledOnce();
    h.converted(visibility);
    fireEvent.click(check);
    await waitFor(() => expect(h.close).toHaveBeenCalledOnce());
    expect(h.sign).toHaveBeenCalledOnce();
    expect(h.publish).toHaveBeenCalledOnce();
  },
);
it("blocks an empty name, then converts and checks an uncertain save under the chosen name", async () => {
  const h = setup();
  await ready();
  const user = userEvent.setup();
  await user.clear(nameField());
  expect(confirm()).toBeDisabled();
  expect(screen.getByRole("alert")).toHaveTextContent("Enter a channel name");
  h.publish.mockRejectedValueOnce(new Error("lost acknowledgement"));
  await user.type(nameField(), "#launch plan ");
  expect(h.sign).not.toHaveBeenCalled();
  fireEvent.click(confirm());
  const check = await screen.findByRole("button", { name: "Check status" });
  expect(nameField()).toHaveValue("launch plan");
  expect(nameField()).toBeDisabled();
  h.rename("launch plan");
  h.converted();
  fireEvent.click(check);
  await waitFor(() => expect(h.close).toHaveBeenCalledOnce());
  expect(h.sign).toHaveBeenCalledOnce();
  expect(h.publish).toHaveBeenCalledOnce();
  expect(h.sign.mock.calls[0]?.[0].tags).toContainEqual([
    "name",
    "launch plan",
  ]);
});
it("definitive rejection permits explicit retry without losing the confirmation", async () => {
  const h = setup();
  h.publish.mockRejectedValueOnce(new PublishRejected("Denied"));
  await ready();
  fireEvent.click(confirm());
  expect(await screen.findByRole("alert")).toHaveTextContent("Denied");
  await ready();
  fireEvent.click(confirm());
  await waitFor(() => expect(h.close).toHaveBeenCalledOnce());
  expect(h.publish).toHaveBeenCalledTimes(2);
});
it("a chat without the Solo label cannot convert", async () => {
  const h = setup(false);
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("Only a Solo chat"),
  );
  expect(confirm()).toBeDisabled();
  expect(h.publish).not.toHaveBeenCalled();
});
it.each(["visit", "unmount"])(
  "%s during signing prevents publication and late modal close",
  async (retire) => {
    const h = setup();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.sign.mockImplementationOnce(async (template) => {
      await held;
      return finalizeEvent(template, key);
    });
    await ready();
    fireEvent.click(confirm());
    try {
      await waitFor(() => expect(h.sign).toHaveBeenCalledOnce());
      expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
      if (retire === "visit") h.visit.abort();
      else h.mounted.unmount();
    } finally {
      await act(async () => {
        release();
        await held;
      });
    }
    await waitFor(() =>
      expect(h.details.capability.snapshot(id)).toBeUndefined(),
    );
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.close).not.toHaveBeenCalled();
    if (retire === "visit") {
      const cancel = screen.getByRole("button", { name: "Cancel" });
      await waitFor(() => expect(cancel).toBeEnabled());
      fireEvent.click(cancel);
      expect(h.close).toHaveBeenCalledOnce();
    }
  },
);

it("an unrelated unconfirmed metadata change cannot be checked as conversion", async () => {
  const h = setup();
  await ready();
  const base = await h.details.capability.load(id);
  h.publish.mockRejectedValueOnce(new Error("lost acknowledgement"));
  await act(async () => {
    await h.details.capability
      .save(base, { ...base, name: "Other edit" })
      .catch(() => {});
  });
  expect(screen.getByRole("status")).toHaveTextContent("Finish the existing");
  expect(screen.queryByRole("button", { name: "Check status" })).toBeNull();
  expect(confirm()).toBeDisabled();
  expect(h.publish).toHaveBeenCalledOnce();
});

it("finishes when another details consumer confirmed the uncertain conversion", async () => {
  const h = setup();
  h.publish.mockRejectedValueOnce(new Error("lost acknowledgment"));
  await ready();
  fireEvent.click(confirm());
  await screen.findByRole("alert");
  h.mounted.unmount();
  h.converted();
  await h.session.channelDetails.check(id);
  expect(h.session.channelDetails.snapshot(id)).toBeUndefined();
  expect(chatConversion(h.session, id)?.converted).not.toBe(true);
  render(
    <ConvertToChannel
      session={h.session}
      id={id}
      close={h.close}
      onConverted={h.convertedCallback}
    />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Finish conversion" }),
  );
  await waitFor(() => expect(h.convertedCallback).toHaveBeenCalledOnce());
  expect(h.publish).toHaveBeenCalledOnce();
  expect(h.unfile).not.toHaveBeenCalled();
});
it("serializes metadata recovery across two mounted forms", async () => {
  const h = setup();
  await ready();
  h.publish.mockRejectedValueOnce(new Error("lost acknowledgment"));
  fireEvent.click(confirm());
  await screen.findByRole("alert");
  h.mounted.unmount();
  h.converted();
  await h.session.channelDetails.check(id);
  render(
    <ConvertToChannel
      session={h.session}
      id={id}
      close={h.close}
      onConverted={h.convertedCallback}
    />,
  );
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const load = h.read.getMockImplementation();
  if (!load) throw new Error("Missing details reader");
  const first = await screen.findByRole("button", {
    name: "Finish conversion",
  });
  h.read.mockImplementationOnce(async () => {
    await held;
    return load();
  });
  fireEvent.click(first);
  try {
    render(<ConvertToChannel session={h.session} id={id} close={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getAllByRole("dialog", { hidden: true })).toHaveLength(2),
    );
    expect(first).toBeDisabled();
    const other = screen.getByRole("dialog");
    expect(
      within(other).getByRole("button", { name: /convert|finish/i }),
    ).toBeDisabled();
    expect(h.publish).toHaveBeenCalledOnce();
  } finally {
    await act(async () => release());
  }
  await waitFor(() => expect(h.convertedCallback).toHaveBeenCalledOnce());
});

it.each([
  ["someone else is a member", true],
  ["only the owner is a member", false],
] as const)(
  "offers opening a private chat only when nobody else is a member: %s",
  async (_, blocked) => {
    setup(true, "private", undefined, [
      viewer,
      ...(blocked ? ["d".repeat(64)] : []),
    ]);
    await ready();
    const user = userEvent.setup();
    await user.click(accessControl());
    for (const name of ["Public", "View only"]) {
      const option = await screen.findByRole("option", { name });
      if (blocked) {
        expect(option).toHaveAttribute("aria-disabled", "true");
        expect(option).toHaveAccessibleDescription(
          "Has other members. Create a new channel instead.",
        );
      } else expect(option).not.toHaveAttribute("aria-disabled", "true");
    }
    await user.click(screen.getByRole("option", { name: "View only" }));
    expect(accessControl()).toHaveTextContent(
      blocked ? "Private" : "View only",
    );
  },
);

it("closes opening once a member's profile shows a person", async () => {
  const h = setup(true, "private", undefined, [viewer, "d".repeat(64)], false);
  await ready();
  const user = userEvent.setup();
  await user.click(accessControl());
  expect(
    await screen.findByRole("option", { name: "View only" }),
  ).not.toHaveAttribute("aria-disabled", "true");
  await user.keyboard("{Escape}");
  act(() => h.loadProfiles());
  await user.click(accessControl());
  expect(
    await screen.findByRole("option", { name: "View only" }),
  ).toHaveAttribute("aria-disabled", "true");
});

async function viewOnlyDisabled(user: ReturnType<typeof userEvent.setup>) {
  await user.click(accessControl());
  const option = await screen.findByRole("option", { name: "View only" });
  const disabled = option.getAttribute("aria-disabled") === "true";
  await user.keyboard("{Escape}");
  return disabled;
}

it("closes opening once another owner is verified for a member agent", async () => {
  const agent = "d".repeat(64);
  const h = setup(true, "private", undefined, [viewer, agent], false);
  act(() =>
    h.loadProfiles({ name: "Bot", isAgent: true, ownerPubkey: "e".repeat(64) }),
  );
  await ready();
  const user = userEvent.setup();
  expect(await viewOnlyDisabled(user)).toBe(false);
  act(() => h.verifyOwner(agent, "e".repeat(64)));
  expect(await viewOnlyDisabled(user)).toBe(true);
});

it("leaves an untagged member to the relay until the agent inventory is complete", async () => {
  const h = setup(true, "private", undefined, [viewer, "d".repeat(64)]);
  act(() => h.setInventoryComplete(false));
  await ready();
  const user = userEvent.setup();
  expect(await viewOnlyDisabled(user)).toBe(false);
  act(() => h.setInventoryComplete(true));
  expect(await viewOnlyDisabled(user)).toBe(true);
});

it("refuses a View only pick the opening check closes after it was made", async () => {
  const h = setup(true, "private", undefined, [viewer, "d".repeat(64)], false);
  await ready();
  await selectAccess("View only");
  act(() => h.loadProfiles());
  expect(confirm()).toBeDisabled();
  expect(
    screen.getAllByRole("status").map((status) => status.textContent),
  ).toContain("Has other members. Create a new channel instead.");
  fireEvent.click(confirm());
  // Enter in the name field submits the form past the disabled button.
  const form = document.querySelector("form");
  if (!form) throw new Error("missing form");
  fireEvent.submit(form);
  await act(async () => {});
  expect(h.publish).not.toHaveBeenCalled();
  await selectAccess("Private");
  await ready();
  fireEvent.click(confirm());
  await waitFor(() => expect(h.publish).toHaveBeenCalledOnce());
  const tags = h.sign.mock.calls[0]?.[0].tags;
  expect(tags).not.toContainEqual(["visibility", "open"]);
  expect(tags).not.toContainEqual(["join_role", "guest"]);
});

it("closes opening from the profile and inventory loads it starts", async () => {
  setup(true, "private", undefined, [viewer, "d".repeat(64)], true, true);
  await ready();
  const user = userEvent.setup();
  await waitFor(async () => expect(await viewOnlyDisabled(user)).toBe(true));
});

it.each([
  ["Public", "member"],
  ["View only", "guest"],
] as const)(
  "keeps switching an already %s chat open when someone else is a member",
  async (current, joinRole) => {
    setup(true, "public", joinRole, [viewer, "d".repeat(64)]);
    await ready();
    expect(accessControl()).toHaveTextContent(current);
    const user = userEvent.setup();
    await user.click(accessControl());
    for (const name of ["Public", "View only"])
      expect(await screen.findByRole("option", { name })).not.toHaveAttribute(
        "aria-disabled",
        "true",
      );
  },
);
