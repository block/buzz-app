// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { sessionsData } from "../../../tests/fixtures/channel-sessions-data";
import { createRetainedSessions } from "./retained-sessions";
import { PersonalSessions } from "./PersonalSessions";
import { RecentChannelThreads } from "./RecentChannelThreads";

afterEach(cleanup);
it.each([true, false])(
  "keeps the directory exit with no known children (retained capability: %s)",
  async (supported) => {
    const data = sessionsData({ rowCount: 0 });
    const owner = createRetainedSessions();
    const openDirectory = vi.fn();
    const {
      retained: _retained,
      subscribeRetained: _subscribeRetained,
      ...channels
    } = data.session.channels;
    const session = supported ? data.session : { ...data.session, channels };
    try {
      render(
        <PersonalSessions
          session={session}
          owner={owner}
          channelId="general"
          channelName="General"
          scope="test"
          directorySelected={true}
          openThread={vi.fn()}
          openDirectory={openDirectory}
        />,
        { reactStrictMode: true },
      );
      const all = screen.getByRole("button", { name: "View all sessions" });
      expect(screen.getAllByRole("button")).toHaveLength(1);
      expect(all).toHaveAttribute("aria-current", "page");
      expect(all).toHaveAccessibleDescription(
        supported
          ? "From loaded history · may be incomplete"
          : "Loaded session preview unavailable",
      );
      expect(all).toHaveAttribute(
        "title",
        supported
          ? "From loaded history · may be incomplete"
          : "Loaded session preview unavailable",
      );
      expect(all.querySelector("span")).toBeNull();
      await userEvent.setup().click(all);
      expect(openDirectory).toHaveBeenCalledOnce();
    } finally {
      cleanup();
      owner.dispose();
      data.dispose();
    }
  },
);

it("changes only the sidebar title while real retained messages and directory chips keep the original prompt", async () => {
  const data = sessionsData({ rowCount: 3 });
  const owner = createRetainedSessions();
  const openThread = vi.fn(() => true);
  try {
    data.session.channels.ensureList();
    await waitFor(() =>
      expect(data.session.channels.list().status).toBe("ready"),
    );
    data.session.channels.ensure("general");
    await waitFor(() =>
      expect(data.session.channels.window("general").status).toBe("ready"),
    );
    render(
      <>
        <PersonalSessions
          session={data.session}
          owner={owner}
          directorySelected={false}
          channelId="general"
          channelName="General"
          scope="test"
          openThread={openThread}
          openDirectory={vi.fn()}
        />
        <RecentChannelThreads
          session={data.session}
          channelId="general"
          channelName="General"
          scope="test"
          openThread={openThread}
        />
      </>,
      { reactStrictMode: true },
    );
    const sidebar = screen.getByRole("region", {
      name: "Your sessions in General",
    });
    const directory = screen.getByRole("region", {
      name: "Sessions",
    });
    await waitFor(() =>
      expect(
        within(sidebar).getByRole("button", {
          name: /^Investigate task 3/,
        }),
      ).toBeVisible(),
    );
    const original = "@Fixture member Investigate task 3";
    const rootId = data.rows[2]?.rootId;
    expect(
      data.session.channels.retained?.().find((row) => row.id === rootId)
        ?.excerpt,
    ).toBe(original);
    expect(
      data.session.channels
        .window("general")
        .rows.find((row) => row.id === rootId)?.content,
    ).toBe(original);
    expect(
      within(
        within(directory).getByRole("button", { name: /Investigate task 3/ }),
      ).getByRole("img", { name: "Agent Fixture member" }),
    ).toBeVisible();
    await userEvent.setup().click(
      within(sidebar).getByRole("button", {
        name: /^Investigate task 3/,
      }),
    );
    expect(openThread).toHaveBeenCalledWith(rootId);
    // Unmount the directory (the only reader); cached-name publication is enough.
    cleanup();
    const reads = data.report.queries.length;
    render(
      <PersonalSessions
        session={data.session}
        owner={owner}
        directorySelected={false}
        channelId="general"
        channelName="General"
        scope="test"
        openThread={openThread}
        openDirectory={vi.fn()}
      />,
      { reactStrictMode: true },
    );
    act(() => data.renameMember("Renamed"));
    expect(
      screen.getByRole("button", {
        name: /^@Fixture member Investigate task 3/,
      }),
    ).toBeVisible();
    act(() => data.renameMember("Fixture member"));
    expect(
      screen.getByRole("button", { name: /^Investigate task 3/ }),
    ).toBeVisible();
    expect(data.report.queries).toHaveLength(reads);
    expect(data.report.published).toEqual([]);
  } finally {
    cleanup();
    owner.dispose();
    data.dispose();
  }
});
