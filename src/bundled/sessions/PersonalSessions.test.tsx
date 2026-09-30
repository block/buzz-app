// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { sessionsData } from "../../../tests/fixtures/channel-sessions-data";
import { createRetainedSessions } from "./retained-sessions";
import { PersonalSessions } from "./PersonalSessions";

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
