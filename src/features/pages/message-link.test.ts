import { expect, it, vi } from "vitest";
import type { OpenTarget } from "../navigation/targets";
import { offerMessageLink } from "./message-link";
import type { RegisteredPage } from "./service";

it("ignores a result whose resolver or validator used the time reserved for Channels", async () => {
  vi.useFakeTimers();
  try {
    const messageId = "f".repeat(64);
    const target: Extract<OpenTarget, { kind: "conversation" }> = {
      version: 1,
      kind: "conversation",
      channelId: "alpha",
      messageId,
      scope: {
        viewer: "a".repeat(64),
        communityOrigin: "https://relay.example",
      },
    };
    const resolve = vi.fn(() => true);
    const page: RegisteredPage = {
      pluginId: "example",
      id: "board",
      key: "example/board",
      revision: "one",
      title: "Board",
      component: () => null,
      route: {
        version: 1,
        resolveMessageLink: () => "board",
        validate: () => {
          vi.advanceTimersByTime(100);
          return true;
        },
      },
    };
    await offerMessageLink(
      { snapshot: () => [page], subscribe: () => () => {} },
      target,
      messageId,
      () => true,
      new AbortController().signal,
      100,
      resolve,
    );
    expect(resolve).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
