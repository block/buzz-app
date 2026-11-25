import type { ChannelDetailsCapability } from "./channel-details";
import type {
  ChannelDetails,
  ChannelDetailsDraft,
} from "./channel-details-protocol";
import { PublishRejected } from "./outbox";

/** Numbered names tried after the chosen one: -2 through -10. */
export const FREE_NAME_ATTEMPTS = 9;
const NAME_LIMIT = 120;

/** Whether the relay refused the name because an open conversation has it. */
export function nameTaken(error: unknown) {
  if (!(error instanceof Error)) return false;
  const text = `${error instanceof PublishRejected ? (error.reason ?? "") : ""} ${error.message}`;
  return /an open channel named .* already exists/i.test(text);
}

function numbered(name: string, number: number) {
  const suffix = `-${number}`;
  return `${[...name].slice(0, NAME_LIMIT - suffix.length).join("")}${suffix}`;
}

/**
 * Saves `draft`, and when the relay refuses its name because an open
 * conversation already has it, tries again with -2, -3… up to a small cap.
 * Nothing is looked up first; only that refusal retries. Returns the name
 * that was saved.
 */
export async function saveWithFreeName(
  details: Pick<ChannelDetailsCapability, "save">,
  base: ChannelDetails,
  draft: ChannelDetailsDraft,
  signal?: AbortSignal,
  active?: () => boolean,
): Promise<string> {
  const attempt = (next: ChannelDetailsDraft) =>
    active
      ? details.save(base, next, signal, active)
      : details.save(base, next, signal);
  try {
    await attempt(draft);
    return draft.name;
  } catch (error) {
    if (!nameTaken(error)) throw error;
    let last = error;
    for (let number = 2; number < 2 + FREE_NAME_ATTEMPTS; number++) {
      const name = numbered(draft.name, number);
      try {
        await attempt({ ...draft, name });
        return name;
      } catch (retry) {
        if (!nameTaken(retry)) throw retry;
        last = retry;
      }
    }
    throw last;
  }
}
