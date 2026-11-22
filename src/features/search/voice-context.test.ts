// @vitest-environment jsdom
import { afterEach, assert, describe, expect, it, vi } from "vitest";
const byId = (id: string) => {
  const el = document.getElementById(id);
  assert(el);
  return el;
};
import type { ChannelMessage, ChannelSummary } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import {
  captureVoiceThing,
  captureVoiceThingFromElement,
  isMiddleClickExcluded,
  trackPointerPosition,
} from "./voice-context";

function makeSession({
  channels = [],
  messages = {},
  sections = [],
  starred = [],
  profiles = new Map(),
  agents = [],
}: {
  channels?: ChannelSummary[];
  messages?: Record<string, ChannelMessage[]>;
  sections?: { id: string; name: string; order: number }[];
  starred?: string[];
  profiles?: Map<string, { name: string; isAgent?: boolean }>;
  agents?: { pubkey: string; name: string }[];
} = {}): RelaySession {
  return {
    channels: {
      list: () => ({ status: "ready", channels }),
      get: (id: string) => channels.find((c) => c.id === id),
      window: (id: string) => ({
        channelId: id,
        status: "ready",
        rows: messages[id] ?? [],
        hasMore: false,
        loadingOlder: false,
        error: undefined,
      }),
    },
    sidebarPreferences: {
      snapshot: () => ({
        status: "ready",
        data: { sections, assignments: {}, starred, muted: [] },
      }),
    },
    profiles: {
      snapshot: () => profiles,
    },
    agentChoices: {
      snapshot: () => ({ identities: agents }),
    },
  } as unknown as RelaySession;
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("captureVoiceThing", () => {
  it("captures a message in a channel timeline from pointer coordinates", () => {
    const author = "a".repeat(64);
    const session = makeSession({
      messages: {
        c1: [
          {
            id: "m1",
            channelId: "c1",
            authorId: author,
            createdAt: 100,
            content: "Please check the release notes",
            mentions: [],
            attachments: [],
            reactions: [],
            replyCount: 0,
            participants: [],
          } as ChannelMessage,
        ],
      },
      profiles: new Map([[author, { name: "Alice" }]]),
    });

    document.body.innerHTML = `
      <section data-channel-timeline="c1">
        <div data-message-id="m1">
          <span data-message-author="">Alice</span>
          <p id="target">Please check the release notes</p>
        </div>
      </section>
    `;
    const target = byId("target");
    document.elementsFromPoint = vi.fn(() => [target]);

    const captured = captureVoiceThing({
      pointer: { x: 10, y: 20, inside: true },
      session,
      resolveName: (_pk, fallback) => fallback,
    });

    expect(captured).toEqual({
      kind: "message",
      id: "m1",
      channelId: "c1",
      authorId: author,
      authorName: "Alice",
      preview: "Please check the release notes",
      label: 'message from Alice: "Please check the release notes"',
    });
  });

  it("captures a message inside an open ThreadPanel using data-thread-channel", () => {
    const session = makeSession();
    document.body.innerHTML = `
      <section data-thread-channel="c2" data-thread-root="root-1">
        <div data-message-id="reply-9">
          <span data-message-author="">Bob</span>
          <p id="reply-body">Reply body</p>
        </div>
      </section>
    `;
    const body = byId("reply-body");
    document.elementsFromPoint = vi.fn(() => [body]);

    const captured = captureVoiceThing({
      pointer: { x: 5, y: 5, inside: true },
      session,
    });

    expect(captured).toEqual({
      kind: "message",
      id: "reply-9",
      channelId: "c2",
      threadRootId: "root-1",
      authorName: "Bob",
      label: "message from Bob",
    });
  });

  it("prefers channel row over its enclosing sidebar section", () => {
    const session = makeSession({
      channels: [
        {
          id: "sec",
          name: "buzz-security",
          channelType: "stream",
        } as ChannelSummary,
      ],
      sections: [{ id: "work", name: "Work", order: 0 }],
    });

    document.body.innerHTML = `
      <div data-sidebar-section="group:work">
        <details open>
          <summary>Work</summary>
          <button type="button" data-channel-id="sec"><span>buzz-security</span></button>
        </details>
      </div>
    `;
    const span = document.querySelector("button span");
    assert(span);
    document.elementsFromPoint = vi.fn(() => [span]);

    const captured = captureVoiceThing({
      pointer: { x: 50, y: 50, inside: true },
      session,
    });

    expect(captured).toEqual({
      kind: "channel",
      id: "sec",
      name: "buzz-security",
      channelType: "stream",
      sectionKey: "group:work",
      starred: false,
      label: "#buzz-security",
    });
  });

  it("captures sidebar section when hovering its heading", () => {
    const session = makeSession({
      sections: [{ id: "work", name: "Work", order: 0 }],
    });

    document.body.innerHTML = `
      <div data-sidebar-section="group:work">
        <details open>
          <summary id="sec-sum">Work</summary>
        </details>
      </div>
    `;
    const summary = byId("sec-sum");
    document.elementsFromPoint = vi.fn(() => [summary]);

    const captured = captureVoiceThing({
      pointer: { x: 20, y: 20, inside: true },
      session,
    });

    expect(captured).toEqual({
      kind: "section",
      id: "group:work",
      sectionId: "work",
      name: "Work",
      label: "section Work",
    });
  });

  it("captures agent, member person, channel header, and community targets", () => {
    const agentPk = "b".repeat(64);
    const memberPk = "c".repeat(64);
    const session = makeSession({
      channels: [
        { id: "c1", name: "general", channelType: "stream" } as ChannelSummary,
      ],
      agents: [{ pubkey: agentPk, name: "mbot" }],
      profiles: new Map([[memberPk, { name: "Dana" }]]),
    });

    document.body.innerHTML = `
      <div data-agent="${agentPk}" id="ag"></div>
      <div data-member="${memberPk}" id="mem"></div>
      <button data-channel-header="c1" id="hdr">general</button>
      <div data-community-id="comm-1" aria-label="Main Community" id="comm"></div>
    `;

    document.elementsFromPoint = vi.fn(() => [byId("ag")]);
    expect(
      captureVoiceThing({ pointer: { x: 1, y: 1, inside: true }, session }),
    ).toEqual({ kind: "agent", id: agentPk, name: "mbot", label: "mbot" });

    document.elementsFromPoint = vi.fn(() => [byId("mem")]);
    expect(
      captureVoiceThing({
        pointer: { x: 1, y: 1, inside: true },
        session,
        activeChannelId: "c1",
      }),
    ).toEqual({
      kind: "person",
      id: memberPk,
      name: "Dana",
      channelId: "c1",
      label: "Dana",
    });

    document.elementsFromPoint = vi.fn(() => [byId("hdr")]);
    expect(
      captureVoiceThing({ pointer: { x: 1, y: 1, inside: true }, session }),
    ).toEqual({
      kind: "channel",
      id: "c1",
      name: "general",
      channelType: "stream",
      starred: false,
      label: "#general",
    });

    document.elementsFromPoint = vi.fn(() => [byId("comm")]);
    expect(
      captureVoiceThing({ pointer: { x: 1, y: 1, inside: true }, session }),
    ).toEqual({
      kind: "community",
      id: "comm-1",
      name: "Main Community",
      label: "Main Community",
    });
  });

  it("falls back to activeElement when pointer is not inside, and returns nothing over empty timeline", () => {
    const session = makeSession({
      channels: [
        { id: "c1", name: "general", channelType: "stream" } as ChannelSummary,
      ],
    });
    document.body.innerHTML = `
      <section data-channel-timeline="c1" id="bg">
        <button type="button" data-channel-id="c1" id="row">general</button>
      </section>
    `;
    const row = byId("row");
    row.focus();

    expect(
      captureVoiceThing({
        pointer: { x: 0, y: 0, inside: false },
        session,
        activeChannelId: "c1",
      }),
    ).toMatchObject({ kind: "channel", id: "c1", label: "#general" });

    row.blur();
    const bg = byId("bg");
    document.elementsFromPoint = vi.fn(() => [bg]);
    expect(
      captureVoiceThing({
        pointer: { x: 100, y: 100, inside: true },
        session,
        activeChannelId: "c1",
      }),
    ).toEqual({
      kind: "nothing",
      activeChannelId: "c1",
      activeChannelName: "general",
      label: "nothing",
    });
  });

  it("tracks pointermove and focusin timestamps and clears inside on documentElement mouseleave", () => {
    const tracker = trackPointerPosition(window);
    expect(tracker.current().inside).toBe(false);
    window.dispatchEvent(
      new MouseEvent("pointermove", { clientX: 120, clientY: 240 }),
    );
    const afterMove = tracker.current();
    expect(afterMove).toMatchObject({ x: 120, y: 240, inside: true });
    expect((afterMove.pointerAt ?? 0) > (afterMove.focusAt ?? 0)).toBe(true);

    const btn = document.createElement("button");
    document.body.append(btn);
    btn.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    const afterFocus = tracker.current();
    expect((afterFocus.focusAt ?? 0) > (afterFocus.pointerAt ?? 0)).toBe(true);

    document.documentElement.dispatchEvent(new MouseEvent("mouseleave"));
    expect(tracker.current().inside).toBe(false);
    tracker.stop();
  });

  it("prefers activeElement over stale pointer when focus moved more recently", () => {
    const session = makeSession({
      channels: [
        { id: "c1", name: "general", channelType: "stream" } as ChannelSummary,
      ],
    });
    document.body.innerHTML = `
      <div data-message-id="m1" data-channel-timeline="c1"><p id="msg">Hi</p></div>
      <textarea id="composer"></textarea>
    `;
    document.elementsFromPoint = vi.fn(() => [byId("msg")]);
    const composer = byId("composer");
    composer.focus();

    expect(
      captureVoiceThing({
        pointer: {
          x: 10,
          y: 10,
          inside: true,
          pointerAt: 1,
          focusAt: 2,
        },
        session,
        activeChannelId: "c1",
      }),
    ).toEqual({
      kind: "nothing",
      activeChannelId: "c1",
      activeChannelName: "general",
      label: "nothing",
    });
  });

  it("captures directly clicked voice targets without falling back to activeElement", () => {
    const session = makeSession({
      channels: [
        { id: "c1", name: "general", channelType: "stream" } as ChannelSummary,
      ],
    });
    document.body.innerHTML = `
      <button type="button" data-channel-id="c1" id="row"><span>general</span></button>
      <div id="blank">Empty space</div>
    `;
    byId("row").focus();

    expect(
      captureVoiceThingFromElement(byId("row").querySelector("span"), {
        session,
      }),
    ).toMatchObject({
      kind: "channel",
      id: "c1",
      name: "general",
      label: "#general",
    });
    expect(
      captureVoiceThingFromElement(byId("blank"), { session }),
    ).toBeUndefined();
  });

  it("excludes text fields, embedded web pages, closable tabs, and Buzz links from middle-click voice", () => {
    document.body.innerHTML = `
      <div data-message-id="m1">
        <p id="plain">Hello</p>
        <a id="buzz-link" href="buzz://channel/c1"><span>#general</span></a>
        <a id="panel-link" href="panel:foo" data-panel-target="panel:foo">Open</a>
        <a id="web-link" href="https://example.com">Example</a>
        <textarea id="edit-box">Draft</textarea>
        <div id="rich" contenteditable="true"><span id="pill" contenteditable="false">@Ada</span></div>
      </div>
      <span class="buzz-tabs-item" data-closable=""><button type="button" id="closable-tab">Thread</button></span>
      <section aria-label="Browser"><div id="browser-toolbar">Toolbar</div></section>
      <iframe id="frame"></iframe>
    `;

    const auxClickOn = (el: Element | null) => {
      assert(el);
      const event = new MouseEvent("auxclick", {
        bubbles: true,
        cancelable: true,
        button: 1,
      });
      let excluded = false;
      window.addEventListener(
        "auxclick",
        (e) => {
          excluded = isMiddleClickExcluded(e);
        },
        { once: true },
      );
      el.dispatchEvent(event);
      return excluded;
    };

    expect(auxClickOn(byId("plain"))).toBe(false);
    expect(auxClickOn(byId("web-link"))).toBe(false);
    expect(auxClickOn(byId("buzz-link").querySelector("span"))).toBe(true);
    expect(auxClickOn(byId("panel-link"))).toBe(true);
    expect(auxClickOn(byId("edit-box"))).toBe(true);
    expect(auxClickOn(byId("pill"))).toBe(true);
    expect(auxClickOn(byId("closable-tab"))).toBe(true);
    expect(auxClickOn(byId("browser-toolbar"))).toBe(true);
    expect(auxClickOn(byId("frame"))).toBe(true);
  });
});
