import type { Host } from "../host/service";
import type { AttentionSource } from "./attention-sources";

type Sources = { addAttentionSource(source: AttentionSource): void };

/** Attention owns when the producer runs and where output goes. The process
 * host kills descendants on cancellation; no owner credentials are passed as arguments. */
export function registerAttention(ctx: {
  host: Pick<Host, "spawn">;
  agents: Sources;
}) {
  const spawn = ctx.host.spawn?.bind(ctx.host);
  if (!spawn) return;
  for (const id of ["command", "github-pr"])
    ctx.agents.addAttentionSource({
      id,
      async run({ watch, signal, emit }) {
        let buffer = "",
          timer: ReturnType<typeof setTimeout> | undefined,
          ended = false;
        let resolveDrain: (() => void) | undefined;
        const drained = new Promise<void>((resolve) => {
          resolveDrain = resolve;
        });
        const flush = () => {
          clearTimeout(timer);
          timer = undefined;
          if (signal.aborted) {
            buffer = "";
            resolveDrain?.();
            return;
          }
          if (buffer.trim()) {
            try {
              emit(buffer);
              buffer = "";
            } catch {
              timer = setTimeout(flush, 5000);
              return;
            }
          }
          if (ended) resolveDrain?.();
        };
        const append = (data: string) => {
          // Bound output held while the conversation queue is unavailable.
          buffer = (buffer + data).slice(-65536);
          if (!timer)
            timer = setTimeout(() => {
              timer = undefined;
              flush();
            }, 1000);
        };
        const pr = watch.config.pr;
        if (
          id === "github-pr" &&
          (typeof pr !== "string" ||
            !/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/[0-9]+$/.test(pr))
        )
          throw new Error("A PR watch needs a GitHub pull request URL");
        const command =
          id === "github-pr" ? ["--interval", "60", pr] : watch.config.command;
        if (
          !Array.isArray(command) ||
          !command.length ||
          command.some(
            (part) => typeof part !== "string" || part.includes("\0"),
          ) ||
          !command[0]
        )
          throw new Error("A command watch needs a non-empty argument list");
        const cwd = watch.config.cwd;
        if (
          cwd !== undefined &&
          (typeof cwd !== "string" ||
            !(cwd.startsWith("/") || /^[A-Za-z]:[\\/]/.test(cwd)))
        )
          throw new Error("cwd must be absolute");
        const process = await spawn(
          id === "github-pr" ? "attention-pr" : "attention-command",
          {
            args: command,
            ...(typeof cwd === "string" ? { cwd } : {}),
            onStdout: append,
            onStderr: (data) => console.warn("Attention command:", data),
          },
        ).catch((error) => {
          append(`Attention command could not start: ${String(error)}\n`);
          ended = true;
          flush();
          return undefined;
        });
        if (!process) {
          signal.addEventListener("abort", flush, { once: true });
          if (signal.aborted) flush();
          await drained;
          signal.removeEventListener("abort", flush);
          return;
        }
        const abort = () => {
          clearTimeout(timer);
          buffer = "";
          resolveDrain?.();
          void process
            .kill()
            .catch((error) =>
              console.warn("Attention command could not stop", error),
            );
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        try {
          const code = await process.exited;
          if (!signal.aborted && code !== 0)
            append(`\nAttention command exited with status ${code}\n`);
          ended = true;
          clearTimeout(timer);
          timer = undefined;
          flush();
          await drained;
        } finally {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
        }
      },
    });
}
