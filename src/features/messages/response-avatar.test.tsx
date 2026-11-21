// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { stubAvatarBrowserApis } from "../agents/avatar-testing";
import { createRelaySession } from "../relay/session";
import type { ChannelMessage } from "../relay/contracts";
import { MessageRow } from "./MessageRow";
import {
  TypingIndicator,
  useLiveConversationActivity,
} from "./TypingIndicator";
import {
  continuesMessageGroup,
  responseAvatarAnchors,
} from "./message-grouping";
import { agent, human, root, fixture } from "./typing-indicator-testing";
import { stubAvatarAnimationFetch } from "../profiles/avatar-animation-testing";

stubAvatarBrowserApis();
afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.messageDensity;
  vi.unstubAllGlobals();
});

it.each([false, true])(
  "keeps exactly one responding avatar in compact main/thread scope (thread: %s)",
  async (thread) => {
    document.documentElement.dataset.messageDensity = "compact";
    const owner = createRelaySession(null);
    const live = fixture();
    const source = `https://community.test/media/${"9".repeat(64)}.webp`;
    const media = (url: string, size?: "small") =>
      size ? "still" : `protected:${url}`;
    const transfer = stubAvatarAnimationFetch();
    const profile = { name: "Agent", picture: source, isAgent: true as const };
    const session = { ...owner.session, ...live.session, media };
    (session.profiles.snapshot() as Map<string, typeof profile>).set(
      agent,
      profile,
    );
    const row = (
      id: string,
      authorId = agent,
      createdAt = 1,
    ): ChannelMessage => ({
      id,
      authorId,
      channelId: "channel",
      content: id,
      createdAt,
      mentions: [],
      participants: [],
      attachments: [],
      reactions: [],
      replyCount: 0,
      ...(thread ? { threadRootId: root } : {}),
    });
    const rows = [
      row("history"),
      row("request", human, 2),
      row("first", agent, 3),
      row("last", agent, 4),
    ];
    const loads: Array<{ src: string; onload: (() => void) | null }> = [];
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
    }));
    vi.stubGlobal(
      "Image",
      class {
        src = "";
        onload = null;
        constructor() {
          loads.push(this);
        }
      },
    );
    function Conversation() {
      const { agents, responding } = useLiveConversationActivity(
        session,
        "channel",
        thread ? root : undefined,
        false,
      );
      const anchors = responseAvatarAnchors(
        rows,
        responding.includes(agents[0] ?? "") ? agents[0] : undefined,
      );
      return (
        <>
          {rows.map((entry, index) => (
            <MessageRow
              key={entry.id}
              row={entry}
              responseAvatar={anchors.has(entry.id)}
              profile={entry.authorId === agent ? profile : undefined}
              agentPubkeys={new Set([agent])}
              session={session}
              media={media}
              onOpenLink={() => false}
              stackPrevious={continuesMessageGroup(rows[index - 1], entry)}
              stackNext={index === rows.length - 1 && agents[0] === agent}
              day={false}
              retry={undefined}
            />
          ))}
          <TypingIndicator
            inFlow
            session={session}
            channelId="channel"
            threadRootId={thread ? root : undefined}
            previousAuthor={agent}
          />
        </>
      );
    }
    const view = render(<Conversation />);
    const animations = () => [
      ...view.container.querySelectorAll('img[src^="blob:avatar-"]'),
    ];
    try {
      live.update([
        { pubkey: agent, channelId: "channel", threadRootId: "other-thread" },
      ]);
      expect(loads).toHaveLength(0);
      live.update([
        {
          pubkey: agent,
          channelId: "channel",
          ...(thread ? { threadRootId: root } : {}),
        },
      ]);
      await waitFor(() => expect(loads).toHaveLength(1));
      expect(transfer.fetch).toHaveBeenCalledWith(`protected:${source}`, {
        signal: expect.any(AbortSignal),
      });
      expect(loads[0]?.src).toBe("blob:avatar-1");
      expect(animations()).toHaveLength(0);
      act(() => loads[0]?.onload?.());
      expect(animations()).toHaveLength(1);
      expect(animations()[0]?.closest("[data-message-id]")).toHaveAttribute(
        "data-message-id",
        "first",
      );
      expect(
        view.container.querySelector(
          '[data-agent-response-preview] [role="img"]',
        )?.parentElement,
      ).toHaveClass("sr-only");
      live.update([]);
      await waitFor(() => expect(animations()).toHaveLength(0));
      expect(transfer.revoke).toHaveBeenCalledWith("blob:avatar-1");
      expect(
        view.container.querySelector(
          '[data-message-id="first"] img[src="still"]',
        ),
      ).not.toBeNull();
    } finally {
      view.unmount();
      owner.dispose();
    }
  },
);
