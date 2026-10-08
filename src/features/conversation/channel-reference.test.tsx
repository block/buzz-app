// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MessageLink } from "./MessageLink";
import type { ChannelList, ChannelSummary } from "../relay/contracts";
import type { RelaySession } from "../relay/session";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(HTMLElement.prototype, "showPopover");
});

/** A store whose discovery admits public previews only through resolve. */
function fixture(status: ChannelList["status"] = "ready") {
  let list: ChannelList = { status, channels: [] };
  const known = new Map<string, ChannelSummary>();
  const relay = new Map<string, ChannelSummary>();
  const listeners = new Set<() => void>();
  const notify = () => {
    list = { ...list };
    for (const listener of listeners) listener();
  };
  const resolve = vi.fn(async (ids: readonly string[]) => {
    for (const id of ids) {
      const channel = relay.get(id);
      if (channel) known.set(id, channel);
    }
    notify();
  });
  const session = {
    channels: {
      list: () => list,
      get: (id: string) => known.get(id),
      resolve,
      subscribeList(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  } as unknown as RelaySession;
  return {
    session,
    resolve,
    relay,
    known,
    ready() {
      list = { status: "ready", channels: [] };
      act(notify);
    },
  };
}

const link = (session: RelaySession, id: string, label = "#authored") => (
  <MessageLink
    key={id}
    url={`buzz://channel/${id}`}
    registry={undefined}
    onOpenLink={() => true}
    session={session}
  >
    {label}
  </MessageLink>
);

it("looks up an unjoined channel once per id and shows its hover card", async () => {
  vi.useFakeTimers();
  HTMLElement.prototype.showPopover = function () {
    this.style.display = "block";
  };
  const t = fixture();
  t.relay.set("open", {
    id: "open",
    name: "crew-open",
    description: "Where the crew meets.",
    channelType: "stream",
    readOnly: true,
  });
  render(
    <>
      {link(t.session, "open")}
      <MessageLink
        url="buzz://channel/open"
        registry={undefined}
        onOpenLink={() => true}
        session={t.session}
      />
    </>,
  );
  await act(async () => {});
  expect(t.resolve).toHaveBeenCalledTimes(1);
  expect(t.resolve).toHaveBeenCalledWith(["open"]);
  // The authored label stays; a raw link takes the channel's name.
  const [authored, raw] = screen.getAllByRole("link");
  expect(authored?.textContent).toBe("#authored");
  expect(raw?.textContent).toBe("#crew-open");
  fireEvent.mouseEnter(raw as HTMLElement);
  await act(() => vi.advanceTimersByTimeAsync(250));
  const card = screen.getByLabelText("Channel preview");
  expect(card.textContent).toContain("crew-open");
  expect(card.textContent).toContain("Public channel · Not joined");
  expect(card.textContent).toContain("Where the crew meets.");
});

it("shows a private channel when the relay withholds its metadata", async () => {
  const t = fixture();
  render(link(t.session, "secret"));
  await act(async () => {});
  expect(t.resolve).toHaveBeenCalledWith(["secret"]);
  const anchor = screen.getByRole("link", { name: "Private channel" });
  expect(anchor.textContent).toBe("Private channel");
  expect(anchor.getAttribute("href")).toBe("buzz://channel/secret");
  expect(anchor.getAttribute("title")).toContain("aren’t a member");
});

it("keeps the authored label while the lookup is pending or after it fails", async () => {
  const t = fixture();
  let release!: () => void;
  t.resolve.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => (release = resolve));
    throw new Error("offline");
  });
  render(link(t.session, "flaky"));
  await act(async () => {});
  expect(t.resolve).toHaveBeenCalledWith(["flaky"]);
  expect(screen.getByRole("link").textContent).toBe("#authored");
  await act(async () => release());
  expect(screen.getByRole("link").textContent).toBe("#authored");
  expect(screen.queryByText("Private channel")).toBeNull();
});

it("waits for the channel list before reading and skips joined channels", async () => {
  const t = fixture("loading");
  t.known.set("mine", { id: "mine", name: "mine", channelType: "stream" });
  render(
    <>
      {link(t.session, "mine")}
      {link(t.session, "later")}
    </>,
  );
  await act(async () => {});
  expect(t.resolve).not.toHaveBeenCalled();
  t.ready();
  await act(async () => {});
  expect(t.resolve).toHaveBeenCalledTimes(1);
  expect(t.resolve).toHaveBeenCalledWith(["later"]);
});
