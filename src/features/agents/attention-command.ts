import { githubPolicy } from "./github-policy";
import type { Host } from "../host/service";
import type { AttentionSource } from "./attention-sources";

/** Saved identities belong to this bundled owner, including legacy aliases. */
export const bundledAttention = {
  plugin: "buzz.agents",
  providers: [
    { id: "command", provider: "attention/command" },
    { id: "github-pr", provider: "attention/github-pr" },
  ],
} as const;

type Sources = {
  addAttentionSource(source: AttentionSource): void;
};

/** Attention owns when the producer runs and where output goes. The process
 * host kills descendants on cancellation; no owner credentials are passed as arguments. */
export function registerAttention(ctx: {
  agents: Sources;
  host?: Pick<Host, "spawn">;
}) {
  for (const { id } of bundledAttention.providers)
    ctx.agents.addAttentionSource({
      id,
      description:
        id === "command"
          ? "Run a command as the subscribed agent"
          : "Follow GitHub pull request feedback and CI",
      configExample:
        id === "command"
          ? {
              command: ["program", "argument"],
              cwd: "/absolute/optional/directory",
            }
          : { pr: "https://github.com/OWNER/REPO/pull/NUMBER" },
      ...(id === "github-pr"
        ? {
            warnings: async () => {
              const status = await githubPolicy(ctx.host ?? {});
              return status.warning ? [status.warning] : [];
            },
          }
        : {}),
      async run({ watch, signal, emit, spawn }) {
        let omitted = 0;
        let buffer = "",
          stderr = "",
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
              emit(
                `${omitted ? `[${omitted} characters omitted while delivery was unavailable]\n` : ""}${buffer}`,
              );
              buffer = "";
              omitted = 0;
            } catch {
              timer = setTimeout(flush, 5000);
              return;
            }
          }
          if (ended) resolveDrain?.();
        };
        const append = (data: string) => {
          // Deliver full chunks before applying the bound to refused output.
          for (let offset = 0; offset < data.length; ) {
            if (buffer.length === 65536) flush();
            const chunk = data.slice(
              offset,
              offset + (65536 - buffer.length || 65536),
            );
            const combined = buffer + chunk;
            omitted += Math.max(0, combined.length - 65536);
            buffer = combined.slice(-65536);
            offset += chunk.length;
          }
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
        if (!spawn)
          throw new Error(
            "This host cannot run commands as the agent. Update Buzz first.",
          );
        let failure: Error | undefined;
        const process = await spawn(
          id === "github-pr" ? "attention-pr" : "attention-command",
          {
            args: command,
            ...(typeof cwd === "string" ? { cwd } : {}),
            onStdout: append,
            onStderr: (data) => {
              stderr = (stderr + data).slice(-16384);
              console.warn("Attention command:", data);
            },
          },
        ).catch((error) => {
          failure = new Error(
            `Attention command could not start: ${String(error)}`,
          );
          append(`${failure.message}\n`);
          ended = true;
          flush();
          return undefined;
        });
        if (!process) {
          signal.addEventListener("abort", flush, { once: true });
          if (signal.aborted) flush();
          await drained;
          signal.removeEventListener("abort", flush);
          if (!signal.aborted) throw failure;
          return;
        }
        const abort = () => {
          clearTimeout(timer);
          buffer = "";
          resolveDrain?.();
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        try {
          await process.end();
          const code = await process.exited;
          if (!signal.aborted && code !== 0) {
            failure = new Error(
              `Attention command exited with status ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
            );
            append(`\n${failure.message}\n`);
          }
          ended = true;
          clearTimeout(timer);
          timer = undefined;
          flush();
          await drained;
          if (!signal.aborted && failure) throw failure;
        } finally {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
        }
      },
    });
}
