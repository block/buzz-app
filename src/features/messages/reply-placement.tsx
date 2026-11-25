import { useCallback, useEffect, useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { ThreadIcon } from "../../shared/design-system/icons/index";
import styles from "./Messages.module.css";
import type { ReplyPlacement } from "../relay/thread-reference";

/**
 * Where the agents a message mentions answer, chosen beside Send.
 * - `top`: the conversation's own composer. Checked asks for a thread.
 * - `thread`: a thread's composer. Checked asks for a subthread.
 * - `subthread`: already in a subthread, the deepest level. The choice is
 *   off, and agents answer in that subthread.
 */
export type ReplyLevel = "top" | "thread" | "subthread";

const storageKey = "buzz-reply-placement.v1";
const changedEvent = "buzz-reply-placement-changed";
const kept = 500;

type Choices = Record<string, { top?: boolean; thread?: boolean }>;

function readChoices(): Choices {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(storageKey) ?? "{}",
    );
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Choices)
      : {};
  } catch {
    return {};
  }
}

/** The choice last sent at this level of this conversation, on this device. */
export function rememberedReplyChoice(
  channelId: string,
  level: "top" | "thread",
): boolean | undefined {
  const value = readChoices()[channelId]?.[level];
  return typeof value === "boolean" ? value : undefined;
}

function rememberReplyChoice(
  channelId: string,
  level: "top" | "thread",
  checked: boolean,
) {
  const choices = readChoices();
  const { [channelId]: current, ...others } = choices;
  // The newest conversation goes last, so the oldest is dropped first.
  const next: Choices = {
    ...others,
    [channelId]: { ...current, [level]: checked },
  };
  const ids = Object.keys(next);
  for (const id of ids.slice(0, Math.max(0, ids.length - kept)))
    delete next[id];
  try {
    localStorage.setItem(storageKey, JSON.stringify(next));
  } catch {
    // The choice still applies to this composer until it unmounts.
  }
  window.dispatchEvent(new Event(changedEvent));
}

/** The placement a send at `level` asks for. */
export function replyPlacementFor(
  level: ReplyLevel,
  checked: boolean,
): ReplyPlacement {
  if (level === "subthread") return "subthread";
  if (level === "thread") return checked ? "subthread" : "thread";
  return checked ? "thread" : "top";
}

/**
 * The composer's "reply in thread" choice. It starts from what was last sent
 * at this level in this conversation, or else from `suggested`, the
 * etiquette for where the composer is. Sending keeps the choice for next
 * time at this level of this conversation.
 */
export function useReplyPlacement(
  channelId: string | undefined,
  level: ReplyLevel,
  suggested: boolean,
) {
  const remembered = useCallback(
    () =>
      channelId && level !== "subthread"
        ? rememberedReplyChoice(channelId, level)
        : undefined,
    [channelId, level],
  );
  const [choice, setChoice] = useState<boolean | undefined>(remembered);
  // Another conversation or level starts from its own remembered choice.
  useEffect(() => {
    setChoice(remembered());
    const changed = () => setChoice(remembered());
    window.addEventListener(changedEvent, changed);
    return () => window.removeEventListener(changedEvent, changed);
  }, [remembered]);
  const checked = level === "subthread" || (choice ?? suggested);
  const sent = useCallback(() => {
    // Only a choice the person made is kept; the suggestion follows who's here.
    if (!channelId || level === "subthread" || choice === undefined) return;
    rememberReplyChoice(channelId, level, choice);
  }, [channelId, level, choice]);
  return {
    level,
    checked,
    placement: replyPlacementFor(level, checked),
    choose: setChoice,
    sent,
  };
}

/** The composer's choice, for the notice above it. */
export type ReplyChoice = Readonly<{
  level: ReplyLevel;
  checked: boolean;
  choose(checked: boolean): void;
}>;

function agentNames(names: readonly string[]) {
  if (names.length > 2) return `${names.length} agents`;
  return names.join(" and ");
}

/** Above the composer once the draft tags an agent: where it will answer,
 * and the one other place it could. A subthread has no deeper level, so it
 * never shows there. */
export function ReplyPlacementNotice({
  choice,
  agents,
}: {
  choice: ReplyChoice;
  agents: readonly string[];
}) {
  const nested = choice.level === "thread";
  const names = agentNames(agents);
  return (
    <div className={styles.replyContext}>
      <ThreadIcon size={18} aria-hidden="true" />
      <div role="status">
        {choice.checked
          ? `${names} will reply in a ${nested ? "subthread" : "thread"}`
          : `${names} will reply here`}
      </div>
      <Button
        variant="subtle"
        size="sm"
        type="button"
        onClick={() => choice.choose(!choice.checked)}
      >
        {choice.checked
          ? "Reply here instead"
          : nested
            ? "Use a subthread"
            : "Use a thread"}
      </Button>
    </div>
  );
}
