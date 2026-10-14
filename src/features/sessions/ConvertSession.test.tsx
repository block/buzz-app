// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { finalizeEvent, getPublicKey, type EventTemplate } from "nostr-tools";
import { createChannelDetails } from "../relay/channel-details";
import { createRelaySession } from "../relay/session";
import { PublishRejected } from "../relay/outbox";
import { sessionDescription } from "./metadata";
import { ConvertSession } from "./ConvertSession";

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
function setup(description = sessionDescription()) {
  let clock = 100,
    role = "owner",
    name = "Original",
    about = description,
    visibility = "private";
  const record = (kind: number, tags: string[][]) =>
    finalizeEvent(
      { kind, tags: [["d", id], ...tags], content: "", created_at: clock },
      relayKey,
    );
  const metadata = () =>
    record(39000, [
      ["name", name],
      ["about", about],
      ["t", "stream"],
      [visibility],
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
    about = "";
    const choice = event.tags.find(([tag]) => tag === "visibility")?.[1];
    if (choice) visibility = choice === "open" ? "public" : "private";
    clock++;
  });
  const details = createChannelDetails({
    reader: { read },
    writer: { sign, publish },
    viewer,
    relayAuthor,
    canAccess: () => true,
    acceptDiscovery: () => {},
  });
  const owner = createRelaySession(null);
  dispose.push(details.dispose, owner.dispose);
  const session = { ...owner.session, channelDetails: details.capability };
  const close = vi.fn();
  const visit = new AbortController();
  const mounted = render(
    <ConvertSession
      session={session}
      id={id}
      signal={visit.signal}
      close={close}
    />,
  );
  return {
    session,
    close,
    read,
    sign,
    publish,
    visit,
    mounted,
    details,
    authority: (next: string) => {
      role = next;
    },
    rename: () => {
      name = "Changed";
      clock++;
    },
    converted: (next = "private") => {
      about = "";
      visibility = next;
      clock++;
    },
  };
}
const confirm = () =>
  screen.getByRole("button", { name: "Convert to channel" });
async function ready() {
  await waitFor(() => expect(confirm()).toBeEnabled());
}
it("cancel makes no metadata or membership write", async () => {
  const h = setup();
  await ready();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(h.close).toHaveBeenCalledOnce();
  expect(h.sign).not.toHaveBeenCalled();
  expect(h.publish).not.toHaveBeenCalled();
});
it.each(["private", "public"])(
  "converts through signed kind 9002 with explicit %s visibility and unchanged TTL",
  async (visibility) => {
    const h = setup();
    await ready();
    expect(screen.getByRole("radio", { name: "Private" })).toBeChecked();
    expect(
      screen.getByRole("radio", { name: "Public" }),
    ).toHaveAccessibleDescription(
      "Everyone in this community will be able to view this channel’s full history.",
    );
    if (visibility === "public")
      fireEvent.click(screen.getByRole("radio", { name: "Public" }));
    expect(h.sign).not.toHaveBeenCalled();
    fireEvent.click(confirm());
    await waitFor(() => expect(h.close).toHaveBeenCalledOnce());
    expect(h.publish).toHaveBeenCalledOnce();
    const event = h.sign.mock.calls[0]?.[0];
    expect(event?.kind).toBe(9002);
    expect(event?.tags).toEqual([
      ["h", id],
      ["name", "Original"],
      ["about", ""],
      ...(visibility === "public" ? [["visibility", "open"]] : []),
    ]);
    const saved = await h.details.capability.load(id);
    expect(saved).toMatchObject({
      name: "Original",
      description: "",
      visibility,
      ttlSeconds: 86400,
    });
  },
);
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
      screen.getByRole("button", { name: "Reload session details" }),
    );
    await ready();
    fireEvent.click(confirm());
    await waitFor(() => expect(h.close).toHaveBeenCalledOnce());
    expect(h.publish).toHaveBeenCalledOnce();
  },
);
it.each(
  ["private", "public"].flatMap((visibility) =>
    [false, true].map((failedRead) => ({ visibility, failedRead })),
  ),
)(
  "unknown $visibility conversion checks status without resending after remount, failed initial read=$failedRead",
  async ({ visibility, failedRead }) => {
    const h = setup();
    h.publish.mockRejectedValueOnce(new Error("lost acknowledgement"));
    await ready();
    if (visibility === "public")
      fireEvent.click(screen.getByRole("radio", { name: "Public" }));
    fireEvent.click(confirm());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "may have been saved",
    );
    h.mounted.unmount();
    const pending = h.details.capability.snapshot(id);
    if (failedRead)
      h.read.mockRejectedValueOnce(new Error("Details unavailable"));
    render(<ConvertSession session={h.session} id={id} close={h.close} />);
    if (failedRead) {
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Details unavailable",
      );
      expect(confirm()).toBeDisabled();
      expect(screen.queryByRole("button", { name: "Check status" })).toBeNull();
      expect(h.details.capability.snapshot(id)).toBe(pending);
      expect(
        screen.getByRole("radio", {
          name: visibility === "public" ? "Public" : "Private",
        }),
      ).toBeChecked();
      expect(screen.getByRole("radio", { name: "Public" })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
      expect(screen.getByRole("radio", { name: "Private" })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Reload session details" }),
      );
    }
    const check = await screen.findByRole("button", { name: "Check status" });
    expect(h.details.capability.snapshot(id)).toBe(pending);
    expect(
      screen.getByRole("radio", {
        name: visibility === "public" ? "Public" : "Private",
      }),
    ).toBeChecked();
    expect(screen.getByRole("radio", { name: "Public" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("radio", { name: "Private" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    fireEvent.click(
      screen.getByRole("radio", {
        name: visibility === "public" ? "Private" : "Public",
      }),
    );
    expect(
      screen.getByRole("radio", {
        name: visibility === "public" ? "Public" : "Private",
      }),
    ).toBeChecked();
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
it("parent-linked session cannot convert", async () => {
  const h = setup(sessionDescription("22222222-2222-4222-8222-222222222222"));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("permission"),
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
