import type { Contribution } from "../../plugins/contributions";
import type { ComposerInputElement } from "../messages/composer-dom";
import type { CompletionContext, ComposerSendCheck } from "./contracts";

/** How long one check may take before it holds the send. */
export const SEND_CHECK_TIMEOUT_MS = 5000;

/** Runs each check in turn against the composer's current draft. Resolves
 * undefined to send the draft as the checks left it, or the reason to hold
 * it. Fails closed: a missing draft, a throw, a rejection, a timeout, an
 * invalid result or a draft changed by anyone but the check all hold. */
export async function runSendChecks(
  checks: readonly Contribution<ComposerSendCheck>[],
  input: ComposerInputElement | null,
  markdown: () => string,
  context: CompletionContext,
  signal: AbortSignal,
): Promise<string | undefined> {
  for (const sendCheck of checks) {
    const observed = input?.sendObservation();
    if (!input || !observed) return "Finish typing, then send again.";
    let latest = observed.revision;
    let settled = false;
    const replaceRange = (
      start: number,
      end: number,
      text: string,
      revision: number,
    ) => {
      if (settled || signal.aborted || revision !== latest) return false;
      const next = input.replaceRange(revision, start, end, text);
      if (next !== false) latest = next;
      return next;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let result: unknown;
    try {
      result = await Promise.race([
        Promise.resolve().then(() =>
          sendCheck.check({
            ...context,
            draft: Object.freeze({ ...observed, markdown: markdown() }),
            replaceRange,
          }),
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("timed out")),
            SEND_CHECK_TIMEOUT_MS,
          );
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
      ]);
    } catch (error) {
      if (!signal.aborted)
        console.warn(`Send check ${sendCheck.key} failed`, error);
      result = undefined;
    } finally {
      settled = true;
      clearTimeout(timer);
    }
    if (signal.aborted) return "";
    if (typeof result === "string") return result || couldNot(sendCheck);
    if (result !== true) return couldNot(sendCheck);
    if (input.sendObservation()?.revision !== latest)
      return `The message changed while ${sendCheck.title} checked it. Send it again.`;
  }
  return undefined;
}
function couldNot(check: ComposerSendCheck) {
  return `${check.title} could not check this message, so it was not sent.`;
}
