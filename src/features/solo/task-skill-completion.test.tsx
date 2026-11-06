// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createSoloRegionFixture } from "../channel-navigation/solo-navigation-testing";
import type { TaskSkills } from "../channel-navigation/solo-navigation-contract";
import type { CompletionResult } from "../conversation/contracts";
import {
  SelectedMentionContext,
  TaskCompletionContext,
} from "../messages/selected-mention-context";
import type { MentionRecipient } from "../messages/mention-draft";
import { TASK_MODE_LABEL } from "./task-mode";
import { skillQuery, TaskSkillCompletion } from "./task-skill-completion";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  cleanup();
  for (const close of cleanups.splice(0)) await close();
});

it("matches `/` only after a boundary, up to the next slash", () => {
  expect(skillQuery("/rev", 4)).toEqual({ start: 0, end: 4, query: "rev" });
  expect(skillQuery("use (/re", 8)).toEqual({ start: 5, end: 8, query: "re" });
  expect(skillQuery("and/or", 6)).toBeNull();
  expect(skillQuery("see /etc/", 9)).toBeNull();
  expect(skillQuery("/rev", 9)).toBeNull();
  // The bounded look-back starting at a slash inside a word is no boundary.
  const word = `${"x".repeat(10)}/${"r".repeat(159)}`;
  expect(skillQuery(word, word.length)).toBeNull();
});

const a = "b".repeat(64),
  b = "c".repeat(64);
async function fixture(skills?: TaskSkills) {
  const eligible = new Set([a, b]);
  const h = createSoloRegionFixture();
  cleanups.push(h.dispose);
  const source = await h.register({
    task: {
      prepare: async () => ({ ok: false, reason: "unused" }),
      markChannelStarted: async () => "start",
      recordFirstEvent: async () => {},
      participants: {
        eligible: (key) => eligible.has(key),
        // The primary stays a member after it is no longer eligible.
        isParticipant: (_, key) => key === a,
        defaultRecipient: () => a,
        makePrimary: async () => {},
      },
      ...(skills ? { skills } : {}),
    },
  });
  h.roster([
    {
      id: "task",
      name: "Task",
      channelType: "solo",
      creator: h.session.viewer,
      members: [h.session.viewer, a, b],
      labels: ["buzz.solo", source.handle.label, TASK_MODE_LABEL],
    },
  ]);
  const show = (
    task: { draft: boolean } | undefined,
    tagged: readonly MentionRecipient[] = [],
    query = "re",
  ) => {
    const publish = vi.fn((_: CompletionResult) => () => {});
    const view = render(
      <TaskCompletionContext.Provider
        value={task && { binding: source.binding(), ...task }}
      >
        <SelectedMentionContext.Provider value={tagged}>
          <TaskSkillCompletion
            session={h.session}
            scope={h.scope}
            channelId="task"
            publish={publish}
            observation={{
              revision: 1,
              text: `/${query}`,
              start: query.length + 1,
              end: query.length + 1,
            }}
            query={{ start: 0, end: query.length + 1, query }}
          />
        </SelectedMentionContext.Provider>
      </TaskCompletionContext.Provider>,
    );
    const last = () => publish.mock.lastCall?.[0];
    return { view, publish, last };
  };
  return { ...h, source, show, eligible };
}

it("offers a task chat's skills for its one tagged agent or primary and rechecks them on selection", async () => {
  let selectable = true;
  // An older source's row detail is not shown: a row is the skill's name.
  const load = vi.fn<TaskSkills["load"]>(async ({ target }) => ({
    items: [
      {
        id: `{"path":"/${target}/SKILL.md"}`,
        label: "Review",
        detail: `/${target}/SKILL.md · reported · reference only`,
      } as never,
    ],
  }));
  const f = await fixture({ load, selectable: () => selectable });

  const primary = f.show({ draft: false });
  expect(primary.last()?.status).toBe("Loading skills…");
  await waitFor(() => expect(primary.last()?.items).toHaveLength(1));
  const [row] = primary.last()?.items ?? [];
  expect(row).not.toHaveProperty("detail");
  expect(row).toMatchObject({
    label: "Review",
    edit: {
      token: {
        kind: "nexus.skill",
        id: `{"path":"/${a}/SKILL.md"}`,
        label: "Review",
        target: a,
      },
    },
  });
  expect(load).toHaveBeenLastCalledWith(
    {
      binding: f.source.binding(),
      channelId: "task",
      target: a,
      query: "re",
    },
    expect.any(AbortSignal),
  );
  expect(row?.canSelect?.("Enter")).toBe(true);
  selectable = false;
  expect(row?.canSelect?.("Enter")).toBe(false);
  selectable = true;
  primary.view.unmount();
  // A result is never chosen after its query ends.
  expect(row?.canSelect?.("Enter")).toBe(false);

  const tagged = f.show({ draft: false }, [{ pubkey: b, name: "B" }]);
  await waitFor(() =>
    expect(tagged.last()?.items[0]?.edit).toMatchObject({
      token: { target: b },
    }),
  );
  tagged.view.unmount();

  const both = f.show({ draft: false }, [
    { pubkey: a, name: "A" },
    { pubkey: b, name: "B" },
  ]);
  expect(both.last()).toEqual({
    items: [],
    status: "Tag one agent per message",
  });
  both.view.unmount();

  const draft = f.show({ draft: true });
  expect(draft.last()).toEqual({
    items: [],
    status: "Start this task before choosing a session skill.",
  });
  draft.view.unmount();

  f.eligible.delete(a);
  const ineligible = f.show({ draft: false });
  expect(ineligible.last()).toEqual({
    items: [],
    status: "Choose an eligible task agent.",
  });
  ineligible.view.unmount();
  expect(load).toHaveBeenCalledTimes(2);
});

it("reports an empty or failed load, and offers nothing outside a task chat or without a skills source", async () => {
  const load = vi
    .fn<TaskSkills["load"]>()
    .mockResolvedValueOnce({ items: [] })
    .mockResolvedValueOnce({
      items: [],
      status: "Ask this session to report its exact skill paths.",
    })
    .mockRejectedValueOnce(new Error("The task community changed."));
  const f = await fixture({ load, selectable: () => true });
  for (const status of [
    "This agent has reported no matching skills.",
    "Ask this session to report its exact skill paths.",
    "The task community changed.",
  ]) {
    const shown = f.show({ draft: false });
    await waitFor(() => expect(shown.last()).toEqual({ items: [], status }));
    shown.view.unmount();
  }

  let release = (_: Awaited<ReturnType<TaskSkills["load"]>>) => {};
  load.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const ended = f.show({ draft: false });
  await waitFor(() => expect(load).toHaveBeenCalledTimes(4));
  expect(ended.last()?.status).toBe("Loading skills…");
  ended.view.unmount();
  release({ items: [{ id: "late", label: "Late" }] });
  // The completion's reaction to the load runs before this await resumes.
  await load.mock.results[3]?.value;
  expect(ended.publish).toHaveBeenCalledOnce();

  const ordinary = f.show(undefined);
  expect(ordinary.publish).not.toHaveBeenCalled();
  ordinary.view.unmount();
  expect(load).toHaveBeenCalledTimes(4);

  const none = await fixture();
  const silent = none.show({ draft: false });
  expect(silent.publish).not.toHaveBeenCalled();
});

it("refuses a task source whose skills cannot be called", async () => {
  await expect(
    fixture({ load: async () => ({ items: [] }) } as unknown as TaskSkills),
  ).rejects.toThrow("Task drafts require preparation and participant policy");
});
