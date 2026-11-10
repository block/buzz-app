// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import type { useSoloForkLock } from "../../features/solo/useSoloForkLock";
import { SoloForkPreview } from "./SoloForkPreview";

afterEach(cleanup);
it("labels the collapsed inherited excerpt as current history, not previous prompt evidence", () => {
  const owner = createRelaySession(null);
  const retry = vi.fn();
  const state: ReturnType<typeof useSoloForkLock> = {
    createEventId: undefined,
    disabled: false,
    pending: false,
    reason: undefined,
    retry,
    seed: {
      fork: {
        channelId: "11111111-1111-4111-8111-111111111111",
        messageId: "ab".repeat(32),
      },
      inherited: [
        {
          id: "ab".repeat(32),
          authorId: "cd".repeat(32),
          content: "Quoted parent text",
          createdAt: 10,
          channelId: "11111111-1111-4111-8111-111111111111",
          mentions: [],
          attachments: [],
          reactions: [],
          replyCount: 0,
          participants: [],
        },
      ],
      destination: [],
      messages: [],
    },
  };
  try {
    render(<SoloForkPreview session={owner.session} state={state} />);
    const disclosure = screen.getByRole("button", {
      name: /Forked from.*current seed preview/,
    });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Quoted parent text")).toBeNull();
    fireEvent.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("region", { name: "Inherited current seed preview" }),
    ).toHaveTextContent("Quoted parent text");
    expect(
      screen.getByText(/not a record of what an earlier turn received/),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh current seed preview" }),
    );
    expect(retry).toHaveBeenCalledOnce();
  } finally {
    owner.dispose();
  }
});

it("shows read failures immediately with the hook's retry, and nothing for ordinary confirmed chats", () => {
  const owner = createRelaySession(null);
  const retry = vi.fn();
  const state: ReturnType<typeof useSoloForkLock> = {
    createEventId: "ef".repeat(32),
    disabled: true,
    pending: false,
    reason: "Source access revoked",
    seed: undefined,
    retry,
  };
  try {
    const mounted = render(
      <SoloForkPreview session={owner.session} state={state} />,
    );
    expect(screen.getByText(/Retained create event ID/)).toHaveTextContent(
      "ef".repeat(32),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Source access revoked",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry context" }));
    expect(retry).toHaveBeenCalledOnce();
    mounted.rerender(
      <SoloForkPreview
        session={owner.session}
        state={{
          ...state,
          createEventId: undefined,
          disabled: false,
          reason: undefined,
        }}
      />,
    );
    expect(mounted.container).toBeEmptyDOMElement();
  } finally {
    owner.dispose();
  }
});
