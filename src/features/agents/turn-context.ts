import type { TurnFacts, TurnReads } from "./turn-reads";

export type Turn = TurnFacts & Readonly<{ deadline: number; reads: TurnReads }>;

import type { Context } from "@deepseek-ai/cordis";
import { createContributions } from "../../plugins/contributions";

export type TurnLease = Readonly<{
  deadline: number;
  signal: AbortSignal;
  live(): boolean;
}>;

export type TurnContextContribution<TurnValue = Turn> = Readonly<{
  id: string;
  run(turn: TurnValue, signal: AbortSignal): Promise<string | undefined>;
}>;

const DEADLINE_MS = 3_000;
const SECTION_BYTES = 8 * 1024;
const TOTAL_BYTES = 16 * 1024;
const encoder = new TextEncoder();
const escapeKey = (key: string) =>
  key.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ] ?? char,
  );

/** One collector per agent service. Native hooks retain their own semantics.
 * The factory creates a fresh read lease for each contributor, never a shared
 * authority whose lifetime another contributor could extend. */
export function createTurnContext<Turn>(root: Context) {
  const contributions =
    createContributions<TurnContextContribution<Turn>>(root);
  return {
    register(ctx: Context, contribution: TurnContextContribution<Turn>) {
      if (!ctx.pluginOwner?.turnContext)
        throw new Error("Declare host.turnContext access");
      if (!contribution.id.trim() || typeof contribution.run !== "function")
        throw new Error("Turn context needs an id and callback");
      contributions.register(ctx, contribution);
    },
    async collect(options: {
      turn(lease: TurnLease): Turn;
      signal: AbortSignal;
      current(): boolean;
    }): Promise<string> {
      if (options.signal.aborted || !options.current()) return "";
      const entries = [...contributions.snapshot()].sort((a, b) =>
        a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
      );
      if (!entries.length) return "";
      const deadline = Date.now() + DEADLINE_MS;
      const controllers = new Set<AbortController>();
      const abort = () => {
        for (const controller of controllers) controller.abort();
      };
      options.signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, DEADLINE_MS);
      try {
        const results = await Promise.all(
          entries.map(
            (entry) =>
              new Promise<string | undefined>((resolve) => {
                const controller = new AbortController();
                controllers.add(controller);
                let settled = false;
                const active = () => contributions.snapshot().includes(entry);
                const lease: TurnLease = {
                  deadline,
                  signal: controller.signal,
                  live: () =>
                    !controller.signal.aborted &&
                    Date.now() < deadline &&
                    !options.signal.aborted &&
                    options.current() &&
                    active(),
                };
                let unsubscribe = () => {};
                const finish = (value?: string) => {
                  if (settled) return;
                  settled = true;
                  unsubscribe();
                  controllers.delete(controller);
                  controller.abort();
                  resolve(value);
                };
                controller.signal.addEventListener("abort", () => finish(), {
                  once: true,
                });
                unsubscribe = contributions.subscribe(() => {
                  if (!active()) finish();
                });
                // Catch both factory and synchronous callback errors. A rejected or
                // late plugin never prevents the other contributions from landing.
                void Promise.resolve()
                  .then(() => {
                    if (!lease.live()) return undefined;
                    return entry.run(options.turn(lease), controller.signal);
                  })
                  .then(
                    (value) => {
                      if (
                        !lease.live() ||
                        typeof value !== "string" ||
                        !value.trim()
                      ) {
                        finish();
                        return;
                      }
                      const section = `<turn-context key="${escapeKey(entry.key)}">\n${value}\n</turn-context>`;
                      finish(
                        encoder.encode(section).byteLength <= SECTION_BYTES
                          ? section
                          : undefined,
                      );
                    },
                    () => finish(),
                  );
              }),
          ),
        );
        if (options.signal.aborted || !options.current()) return "";
        const accepted: string[] = [];
        let bytes = 0;
        for (let i = 0; i < results.length; i++) {
          const section = results[i];
          // A successful contributor may unload while another is still pending.
          const entry = entries[i];
          if (!section || !entry || !contributions.snapshot().includes(entry))
            continue;
          const size =
            encoder.encode(section).byteLength + (accepted.length ? 2 : 0);
          if (bytes + size > TOTAL_BYTES) continue;
          accepted.push(section);
          bytes += size;
        }
        return accepted.join("\n\n");
      } finally {
        clearTimeout(timer);
        options.signal.removeEventListener("abort", abort);
        abort();
      }
    },
  };
}
