import { assert, afterEach, beforeEach, expect, it, vi } from "vitest";
import { isValidElement, type ReactNode, type ReactElement } from "react";
import { MentionPicker } from "./MentionPicker";
import { MessageComposer } from "./MessageComposer";
import type { RelaySession } from "../relay/session";

// Production handlers with a shallow hook harness; not DOM focus/layout evidence.
const hooks = vi.hoisted(() => ({ states: [] as unknown[], index: 0, id: 0 }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: () => {},
  useId: () => `composer-${++hooks.id}`,
  useRef: () => ({ current: { focus: vi.fn() } }),
  useState(initial: unknown) {
    const i = hooks.index++;
    if (!(i in hooks.states))
      hooks.states[i] = typeof initial === "function" ? initial() : initial;
    return [
      hooks.states[i],
      (value: unknown) => {
        hooks.states[i] = value;
      },
    ];
  },
}));
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
const storage = new Map<string, string>();
beforeEach(() => {
  hooks.states = [];
  hooks.index = hooks.id = 0;
  storage.clear();
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
});
afterEach(() => vi.unstubAllGlobals());
function mount(threadRootId?: string, scope = "scope", writable = true) {
  hooks.states = [];
  const messages = {
    send: vi.fn(() => "channel-id"),
    reply: vi.fn(() => "reply-id"),
  };
  const onSend = vi.fn();
  const session = {
    messages,
    outbox: { supports: () => writable },
  } as unknown as RelaySession;
  const render = () => {
    hooks.index = 0;
    const scoped = MessageComposer({
      session,
      scope,
      channelId: "channel",
      channelName: "General",
      onSend,
      ...(threadRootId ? { threadRootId } : {}),
    });
    return (
      scoped.type as (
        props: typeof scoped.props,
      ) => ReactElement<Record<string, unknown>>
    )(scoped.props);
  };
  const input = () => {
    const field = elements(render()).find((e) => e.type === "textarea");
    if (!field) throw new Error("No composer input");
    return field;
  };
  return {
    render,
    input,
    messages,
    onSend,
    type(text: string) {
      (input().props.onInput as (e: unknown) => void)({
        currentTarget: { value: text },
      });
    },
    submit() {
      (render().props.onSubmit as (e: unknown) => void)({
        preventDefault() {},
      });
    },
    key(shiftKey = false, isComposing = false) {
      const preventDefault = vi.fn();
      (input().props.onKeyDown as (e: unknown) => void)({
        key: "Enter",
        shiftKey,
        nativeEvent: { isComposing },
        preventDefault,
      });
      return preventDefault;
    },
  };
}
it("reuses the editor for channel sends and thread replies, preserving keyboard behavior", () => {
  const channel = mount();
  channel.type("channel draft");
  channel.submit();
  expect(channel.messages.send).toHaveBeenCalledExactlyOnceWith(
    "channel",
    "channel draft",
    [],
  );
  expect(channel.messages.reply).not.toHaveBeenCalled();
  const thread = mount("root");
  thread.type("thread draft");
  expect(thread.key(true)).not.toHaveBeenCalled();
  expect(thread.key(false, true)).not.toHaveBeenCalled();
  expect(thread.messages.reply).not.toHaveBeenCalled();
  expect(thread.key()).toHaveBeenCalledTimes(1);
  expect(thread.messages.reply).toHaveBeenCalledExactlyOnceWith(
    "channel",
    "root",
    "thread draft",
    [],
  );
  expect(thread.messages.send).not.toHaveBeenCalled();
  expect(thread.onSend).toHaveBeenCalledExactlyOnceWith("reply-id");
  expect(thread.input().props.value).toBe("");
});
it("keeps channel, separate thread and identity drafts isolated across remounts", () => {
  mount().type("channel draft");
  mount("one").type("first thread");
  mount("two").type("second thread");
  mount("one", "other identity").type("other identity");
  expect(mount().input().props.value).toBe("channel draft");
  expect(mount("one").input().props.value).toBe("first thread");
  expect(mount("two").input().props.value).toBe("second thread");
  expect(mount("one", "other identity").input().props.value).toBe(
    "other identity",
  );
});
it("keeps the draft on synchronous rejection and clears only after the outbox accepts intent", () => {
  const h = mount("root");
  h.type("retry me");
  h.messages.reply.mockImplementationOnce(() => {
    throw new Error("outbox full");
  });
  h.submit();
  expect(h.input().props.value).toBe("retry me");
  expect(h.onSend).not.toHaveBeenCalled();
  expect(
    elements(h.render()).some(
      (e) => e.props.role === "alert" && e.props.children === "outbox full",
    ),
  ).toBe(true);
  h.submit();
  expect(h.input().props.value).toBe("");
});
it("gives the channel and thread separate input/label identities, and gates unsupported writes", () => {
  const channel = mount().render(),
    thread = mount("root").render();
  const channelInput = elements(channel).find((e) => e.type === "textarea");
  const threadInput = elements(thread).find((e) => e.type === "textarea");
  expect(threadInput?.props.id).not.toBe(channelInput?.props.id);
  expect(threadInput?.props.placeholder).toBe("Reply to thread");
  expect(elements(thread).find((e) => e.type === "label")?.props.htmlFor).toBe(
    threadInput?.props.id,
  );
  expect(
    elements(mount("root", "scope", false).render()).some(
      (e) => e.type === "textarea",
    ),
  ).toBe(false);
});

it.each([undefined, "root"])(
  "carries exact namesake selection into %s, restores it, and never resolves typed names",
  (root) => {
    const first = { pubkey: "a".repeat(64), name: "Honey" };
    const second = { pubkey: "b".repeat(64), name: "Honey" };
    let h = mount(root);
    h.type("@Honey prose only");
    h.submit();
    expect(
      (root ? h.messages.reply : h.messages.send).mock.calls[0]?.at(-1),
    ).toEqual([]);
    h.type("Please help ");
    for (const recipient of [first, second]) {
      const picker = elements(h.render()).find((e) => e.type === MentionPicker);
      assert.exists(picker);
      (picker.props.select as (value: unknown) => void)(recipient);
    }
    h = mount(root);
    expect(
      elements(h.render()).filter((e) => e.props.title === second.pubkey),
    ).toHaveLength(1);
    h.submit();
    expect(
      (root ? h.messages.reply : h.messages.send).mock.calls[0]?.at(-1),
    ).toEqual([first.pubkey, second.pubkey]);
    expect(h.input().props.value).toBe("");
    h = mount(root);
    h.type("@Honey typed after send");
    h.submit();
    expect(
      (root ? h.messages.reply : h.messages.send).mock.calls[0]?.at(-1),
    ).toEqual([]);
  },
);
it("deleting a mention or removing its chip removes notification intent", () => {
  const h = mount();
  const choose = () => {
    const picker = elements(h.render()).find((e) => e.type === MentionPicker);
    assert.exists(picker);
    (picker.props.select as (v: unknown) => void)({
      pubkey: "a".repeat(64),
      name: "Honey",
    });
  };
  choose();
  h.type("no recipient now");
  h.submit();
  expect(h.messages.send.mock.calls[0]?.at(-1)).toEqual([]);
  choose();
  const remove = elements(h.render()).find(
    (e) => e.props.title === "a".repeat(64),
  );
  assert.exists(remove);
  (remove.props.onClick as () => void)();
  h.submit();
  expect(h.messages.send.mock.calls[1]?.at(-1)).toEqual([]);
});

it("ambiguous namesake deletion cannot notify the wrong remaining identity", () => {
  const h = mount();
  for (const key of ["a", "b"]) {
    const picker = elements(h.render()).find((e) => e.type === MentionPicker);
    assert.exists(picker);
    (picker.props.select as (v: unknown) => void)({
      pubkey: key.repeat(64),
      name: "Honey",
    });
  }
  h.type("@Honey help");
  h.submit();
  expect(h.messages.send.mock.calls[0]?.at(-1)).toEqual([]);
});
