import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Contribution } from "../../plugins/contributions";
import type { ComposerInputElement } from "../messages/composer-dom";
import type { ComposerSession } from "../messages/composer-session";
import type { ComposerSendCheck, SendCheckProps } from "./contracts";
import { SEND_CHECK_TIMEOUT_MS, runSendChecks } from "./send-checks";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A draft whose revision moves on every edit, like the editor's. */
function draft(initial: string) {
  const state = { text: initial, revision: 1, composing: false };
  const input = {
    sendObservation: () =>
      state.composing ? null : { revision: state.revision, text: state.text },
    replaceRange: (
      revision: number,
      start: number,
      end: number,
      text: string,
    ) => {
      if (revision !== state.revision || end <= start) return false;
      state.text = state.text.slice(0, start) + text + state.text.slice(end);
      return ++state.revision;
    },
  } as Partial<ComposerInputElement> as ComposerInputElement;
  return { state, input };
}
const check = (
  id: string,
  run: ComposerSendCheck["check"],
): Contribution<ComposerSendCheck> => ({
  id,
  title: `Check ${id}`,
  check: run,
  key: `p/${id}`,
  pluginId: "p",
  revision: "1",
});
const context = {
  session: {} as ComposerSession,
  scope: "scope",
  channelId: "channel",
};
const run = (
  checks: Contribution<ComposerSendCheck>[],
  input: ComposerInputElement | null,
  signal = new AbortController().signal,
) => runSendChecks(checks, input, () => "markdown", context, signal);

it("sends the draft as the checks rewrote it, one after another", async () => {
  const { state, input } = draft("mail a@example.org or b@example.org");
  const seen: SendCheckProps["draft"][] = [];
  const redact = check("redact", ({ draft, replaceRange }) => {
    seen.push(draft);
    // From the end, so earlier offsets hold.
    let revision = replaceRange(22, 35, "[EMAIL]", draft.revision);
    if (revision === false) return "refused";
    revision = replaceRange(5, 18, "[EMAIL]", revision);
    return revision !== false || "refused";
  });
  const after = check("after", ({ draft }) => {
    seen.push(draft);
    return true;
  });
  await expect(run([redact, after], input)).resolves.toBeUndefined();
  expect(state.text).toBe("mail [EMAIL] or [EMAIL]");
  expect(seen.map((item) => item.text)).toEqual([
    "mail a@example.org or b@example.org",
    "mail [EMAIL] or [EMAIL]",
  ]);
  expect(seen[0]?.markdown).toBe("markdown");
});

it("holds with the check's reason and runs no later check", async () => {
  const { input } = draft("hello");
  const later = vi.fn(() => true as const);
  await expect(
    run(
      [check("one", () => "Remove the key first."), check("two", later)],
      input,
    ),
  ).resolves.toBe("Remove the key first.");
  expect(later).not.toHaveBeenCalled();
});

it("holds on a throw, a rejection, an invalid result or a timeout", async () => {
  const { input } = draft("hello");
  const held = "Check one could not check this message, so it was not sent.";
  const cases: ComposerSendCheck["check"][] = [
    () => {
      throw new Error("boom");
    },
    () => Promise.reject(new Error("boom")),
    () => undefined as unknown as true,
    () => "",
  ];
  for (const failing of cases)
    await expect(run([check("one", failing)], input)).resolves.toBe(held);
  const slow = run([check("one", () => new Promise(() => {}))], input);
  await vi.advanceTimersByTimeAsync(SEND_CHECK_TIMEOUT_MS);
  await expect(slow).resolves.toBe(held);
});

it("holds when the person edits the draft while a check runs", async () => {
  const { state, input } = draft("hello");
  let finish = (_: true) => {};
  const pending = run(
    [check("one", () => new Promise<true>((resolve) => (finish = resolve)))],
    input,
  );
  await Promise.resolve();
  state.text = "hello there";
  state.revision++;
  finish(true);
  await expect(pending).resolves.toMatch(/changed while Check one/);
});

it("revokes replaceRange once the check settles or the revision is stale", async () => {
  const { state, input } = draft("hello");
  let kept: SendCheckProps["replaceRange"] | undefined;
  await run(
    [
      check("one", ({ draft, replaceRange }) => {
        kept = replaceRange;
        expect(replaceRange(0, 1, "j", draft.revision + 1)).toBe(false);
        return true;
      }),
    ],
    input,
  );
  expect(kept?.(0, 1, "j", state.revision)).toBe(false);
  expect(state.text).toBe("hello");
});

it("holds without an editor or while composing, and stops when abandoned", async () => {
  await expect(run([check("one", () => true)], null)).resolves.toBeTruthy();
  const { state, input } = draft("hello");
  state.composing = true;
  await expect(run([check("one", () => true)], input)).resolves.toBeTruthy();
  state.composing = false;
  const abandon = new AbortController();
  const later = vi.fn(() => true as const);
  const pending = run(
    [check("one", () => new Promise(() => {})), check("two", later)],
    input,
    abandon.signal,
  );
  abandon.abort();
  await expect(pending).resolves.toBe("");
  expect(later).not.toHaveBeenCalled();
});
