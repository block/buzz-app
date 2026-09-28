// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useCallback, useRef, useState } from "react";
import type { Contribution } from "../../plugins/contributions";
import type {
  ComposerCompletion,
  ComposerCompletionProps,
  CompletionResult,
} from "../../features/conversation/contracts";
import { ComposerCompletions } from "../../features/conversation/ComposerCompletions";
import { useCompletionEditor } from "../../features/conversation/useCompletionEditor";
import type { ComposerInputElement } from "../../features/messages/composer-dom";
import type { ChannelList, Profile } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import { createAgentLibrary } from "../../features/agents/library";
import { createAgentChoices } from "../../features/agents/choices";
import { bindNames } from "../../features/identity-names/service";
import { MentionCompletion } from "./MentionCompletion";
import { mentionQuery } from "./mention-query";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
});
const alice = "a".repeat(64);
function fixture({ missing = false, absent = false } = {}) {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const channelListeners = new Set<() => void>(),
    profileListeners = new Set<() => void>();
  let profiles: ReadonlyMap<string, Profile> = missing
    ? new Map()
    : new Map([[alice, { name: "Alice Fixture" }]]);
  let list: ChannelList = absent
    ? { status: "loading", channels: [] }
    : {
        status: "ready",
        channels: [{ id: "alpha", name: "Alpha", members: [alice] }],
      };
  const queries = {
    snapshot: () => profiles,
    subscribe: (listener: () => void) => {
      profileListeners.add(listener);
      return () => {
        profileListeners.delete(listener);
      };
    },
    ensure: vi.fn(async () => {}),
  };
  const library = createAgentLibrary(undefined);
  const lifetime = new AbortController();
  const names = bindNames({ profiles: queries, agentLibrary: library.queries });
  const session = {
    profiles: queries,
    names,
    channels: {
      list: () => list,
      subscribeList: (listener: () => void) => {
        channelListeners.add(listener);
        return () => {
          channelListeners.delete(listener);
        };
      },
      ensureList() {},
      refreshList: vi.fn(async () => {}),
    },
    agentChoices: createAgentChoices({
      scope: "fixture",
      library: library.queries,
      signal: lifetime.signal,
    }),
    media: () => undefined,
  } as unknown as RelaySession;
  const publications = vi.fn<(result: CompletionResult) => void>();
  const withdrawals = vi.fn();
  function Provider(props: ComposerCompletionProps) {
    const publish = useCallback(
      (result: CompletionResult) => {
        publications(result);
        const withdraw = props.publish(result);
        return withdraw
          ? () => {
              withdrawals();
              withdraw();
            }
          : false;
      },
      [props.publish],
    );
    return <MentionCompletion {...props} publish={publish} />;
  }
  const entries: Contribution<ComposerCompletion>[] = [
    {
      id: "mention",
      key: "fixture/mention",
      pluginId: "fixture",
      revision: "one",
      title: "Mention",
      match: ({ text, start }) => mentionQuery(text, start),
      component: Provider,
    },
  ];
  const registry = { snapshot: () => entries, subscribe: () => () => {} };
  const accepted = vi.fn();
  function Host() {
    // Native textarea supplies the same authored-offset contract without rich-editor layout.
    const input = useRef<ComposerInputElement | null>(null);
    const editor = useCompletionEditor(input, true);
    const [resolved, setResolved] = useState({
      text: "",
      recipients: [] as { start: number; end: number }[],
    });
    return (
      <>
        <textarea
          aria-label="Composer"
          ref={(element) => {
            input.current = element as unknown as ComposerInputElement;
          }}
          onInput={() => editor.observe()}
          onKeyDown={(event) => editor.keys.current?.(event as never)}
        />
        <ComposerCompletions
          registry={registry}
          resolved={{
            text: editor.observation?.text ?? "",
            recipients:
              resolved.text &&
              (editor.observation?.text ?? "").startsWith(
                resolved.text.trimEnd(),
              )
                ? resolved.recipients
                : [],
          }}
          editor={editor}
          input={input}
          session={session}
          scope="fixture"
          channelId="alpha"
          replace={(edit, query) => {
            accepted(edit);
            const field = input.current;
            if (!field) return false;
            field.value = `${field.value.slice(0, query.start)}@${edit.mention?.name} `;
            field.setSelectionRange(field.value.length, field.value.length);
            setResolved({
              text: field.value,
              recipients: [{ start: query.start, end: field.value.length - 1 }],
            });
            return true;
          }}
        />
      </>
    );
  }
  const view = render(<Host />, { reactStrictMode: true });
  const input = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: "Composer",
  });
  const type = (text: string) => {
    act(() => {
      input.focus();
      input.value = text;
      input.setSelectionRange(text.length, text.length);
    });
    fireEvent.input(input);
  };
  return {
    input,
    type,
    publications,
    withdrawals,
    accepted,
    session,
    profiles(next: ReadonlyMap<string, Profile>) {
      profiles = next;
      for (const listener of profileListeners) listener();
    },
    channel(next: ChannelList) {
      list = next;
      for (const listener of channelListeners) listener();
    },
    close() {
      view.unmount();
      names.dispose();
      lifetime.abort();
      library.dispose();
    },
  };
}

it("does not publish settled-empty results while typing prose after accepting a mention", () => {
  const h = fixture();
  try {
    h.type("@Ali");
    fireEvent.click(screen.getByRole("option", { name: /Alice Fixture/ }));
    expect(h.accepted).toHaveBeenCalledOnce();
    expect(h.input).toHaveValue("@Alice Fixture ");
    h.publications.mockClear();
    for (const suffix of [
      "",
      "Please",
      "Please inspect",
      "Please inspect the request",
    ])
      h.type(`@Alice Fixture ${suffix}`);
    expect(h.publications).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
    h.type("@Ali");
    expect(screen.getByRole("option", { name: /Alice Fixture/ })).toBeVisible();
  } finally {
    h.close();
  }
});

it("rejects a refuted choice before roster notifications return and keeps main stable disabled rows", () => {
  const h = fixture();
  try {
    h.type("@Ali");
    const old = screen.getByRole("option", { name: /Alice Fixture/ });
    h.withdrawals.mockClear();
    act(() => {
      h.channel({
        status: "ready",
        channels: [{ id: "alpha", name: "Alpha", members: [] }],
      });
      fireEvent.click(old);
      expect(h.accepted).not.toHaveBeenCalled();
    });
    expect(screen.getByRole("option")).toHaveAttribute("aria-disabled", "true");
    act(() =>
      h.channel({
        status: "ready",
        channels: [{ id: "alpha", name: "Alpha", members: [alice] }],
      }),
    );
    expect(screen.getByRole("option", { name: /Alice Fixture/ })).toBeVisible();
    h.withdrawals.mockClear();
    act(() => {
      h.profiles(new Map([[alice, { name: "Alicia" }]]));
    });
    expect(screen.getByRole("option", { name: /Alicia/ })).toBeVisible();
  } finally {
    h.close();
  }
});

it("preserves missing-name recovery for an admitted prefix across loading/ready evidence", () => {
  const h = fixture({ missing: true, absent: true });
  try {
    h.type("@Ali");
    expect(
      screen.getByRole("option", { name: "Retry suggestions" }),
    ).toBeVisible();
    act(() =>
      h.channel({
        status: "ready",
        channels: [{ id: "alpha", name: "Alpha", members: [alice] }],
      }),
    );
    expect(screen.getByText(/Some names unavailable/)).toBeVisible();
    fireEvent.click(screen.getByRole("option", { name: "Retry suggestions" }));
    expect(h.session.profiles.ensure).toHaveBeenCalled();
    act(() => h.profiles(new Map([[alice, { name: "Alice Fixture" }]])));
    expect(screen.getByRole("option", { name: /Alice Fixture/ })).toBeVisible();
    expect(
      screen.queryByRole("option", { name: "Retry suggestions" }),
    ).toBeNull();
  } finally {
    h.close();
  }
});
