import { useContext, useLayoutEffect } from "react";
import type {
  CompletionResult,
  ComposerCompletionProps,
} from "../conversation/contracts";
import type { HostCompletionResult } from "../conversation/completion";
import {
  SelectedMentionContext,
  TaskCompletionContext,
} from "../messages/selected-mention-context";
import { validateTaskMembers } from "./task-mode";

/** `/` after a boundary, as `@` mentions are matched. */
export function skillQuery(text: string, caret: number) {
  if (!Number.isInteger(caret) || caret < 0 || caret > text.length) return null;
  const before = text.slice(Math.max(0, caret - 160), caret);
  const match = before.match(/(?:^|[\s([{])\/([^/\n\r\t]*)$/u);
  if (!match) return null;
  const query = match[1] ?? "";
  const start = caret - query.length - 1;
  // A bounded slice beginning in the middle of a word is not a boundary.
  if (start && !/[\s([{]/u.test(text[start - 1] ?? "")) return null;
  return { start, end: caret, query };
}

/** `/` in a task chat offers its source's skills for the message's one tagged
 * agent, else the task primary, as `nexus.skill` chips. Other composers get
 * nothing. */
export function TaskSkillCompletion({
  session,
  channelId,
  query,
  publish,
}: ComposerCompletionProps) {
  const task = useContext(TaskCompletionContext);
  const selected = useContext(SelectedMentionContext);
  const tagged = [...new Set(selected.map((person) => person.pubkey))];
  let context: ReturnType<typeof validateTaskMembers>;
  let primary: string | undefined;
  try {
    context =
      task && !task.draft ? validateTaskMembers(session, channelId) : undefined;
    primary = context?.mode.participants.defaultRecipient(channelId);
    if (primary && !context?.mode.participants.eligible(primary))
      primary = undefined;
  } catch {
    context = undefined;
  }
  const skills = context?.mode.skills;
  const { scope, viewer, incarnation } = context?.binding ?? {};
  const target = tagged.length > 1 ? undefined : (tagged[0] ?? primary);
  const hint =
    tagged.length > 1
      ? "Tag one agent per message"
      : "Choose an eligible task agent.";
  useLayoutEffect(() => {
    let withdraw: (() => void) | false = false;
    const show = (result: HostCompletionResult) => {
      if (withdraw) withdraw();
      withdraw = publish(result as unknown as CompletionResult);
    };
    const controller = new AbortController();
    if (task?.draft)
      show({
        items: [],
        status: "Start this task before choosing a session skill.",
      });
    else if (skills && scope && viewer && incarnation && !target)
      show({ items: [], status: hint });
    else if (skills && scope && viewer && incarnation && target) {
      const binding = { scope, viewer, incarnation };
      const input = { binding, channelId, target };
      show({ items: [], status: "Loading skills…" });
      // One reaction on the source's promise: settling it settles the row.
      const shown = (result: HostCompletionResult) => {
        if (!controller.signal.aborted) show(result);
      };
      void skills
        .load({ ...input, query: query.query }, controller.signal)
        .then(
          (result) =>
            shown({
              items: result.items.map((item) => ({
                id: `nexus.skill:${item.id}`,
                label: item.label,
                edit: {
                  token: {
                    kind: "nexus.skill" as const,
                    id: item.id,
                    label: item.label,
                    target,
                  },
                },
                canSelect: () => {
                  try {
                    return (
                      !controller.signal.aborted &&
                      skills.selectable({ ...input, id: item.id })
                    );
                  } catch {
                    return false;
                  }
                },
              })),
              ...(result.status
                ? { status: result.status }
                : result.items.length
                  ? {}
                  : { status: "This agent has reported no matching skills." }),
            }),
          (reason: unknown) =>
            shown({
              items: [],
              status:
                reason instanceof Error
                  ? reason.message
                  : "Skills are unavailable.",
            }),
        );
    }
    return () => {
      controller.abort();
      if (withdraw) withdraw();
    };
  }, [
    task?.draft,
    skills,
    scope,
    viewer,
    incarnation,
    channelId,
    target,
    hint,
    query.query,
    publish,
  ]);
  return null;
}
