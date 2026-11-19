import { parseOpenTarget, type OpenTarget } from "../navigation/targets";
import type { PagesReader } from "./service";

type ConversationTarget = Extract<OpenTarget, { kind: "conversation" }>;

export async function offerMessageLink(
  pages: PagesReader,
  target: ConversationTarget,
  threadRootId: string,
  live: () => boolean,
  signal: AbortSignal,
  remaining: number,
  resolve: (target: OpenTarget) => boolean,
) {
  const { channelId, messageId, scope } = target;
  if (!messageId) return;
  const link = Object.freeze({ channelId, messageId, scope, threadRootId });
  // A provider that does not answer must leave time for ordinary presentation.
  const duration = Math.min(remaining, 1000);
  const deadline = performance.now() + duration;
  const budget = AbortSignal.any([
    signal,
    AbortSignal.timeout(Math.floor(duration)),
  ]);
  const candidates = [...pages.snapshot()].sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  );
  for (const page of candidates) {
    const route = page.route;
    if (!route?.resolveMessageLink || !pages.snapshot().includes(page))
      continue;
    if (budget.aborted || performance.now() >= deadline || !live()) return;
    const removed = new AbortController();
    const stop = pages.subscribe(() => {
      if (!pages.snapshot().includes(page)) removed.abort();
    });
    const attempt = AbortSignal.any([budget, removed.signal]);
    let onAbort = () => {};
    try {
      if (attempt.aborted) continue;
      const cancelled = new Promise<undefined>((done) => {
        onAbort = () => done(undefined);
        attempt.addEventListener("abort", onAbort, { once: true });
      });
      const params = await Promise.race([
        route.resolveMessageLink(link, attempt),
        cancelled,
      ]);
      if (params === undefined || attempt.aborted || !live()) continue;
      const next = parseOpenTarget({
        version: 1,
        kind: "page",
        pluginId: page.pluginId,
        pageId: page.id,
        scope,
        route: { version: route.version, params },
      });
      if (
        next.kind === "page" &&
        next.route &&
        route.validate(next.route.params) &&
        !attempt.aborted &&
        performance.now() < deadline &&
        live() &&
        pages.snapshot().includes(page) &&
        resolve(next)
      )
        return;
    } catch {
      // A contribution cannot prevent the ordinary message reveal.
    } finally {
      attempt.removeEventListener("abort", onAbort);
      stop();
      removed.abort();
    }
  }
}
