import { expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { registerAttention } from "./attention-command";
it("runs a real producer and delivers stdout without an agent turn per check", async () => {
  let run;
  registerAttention({
    agents: {
      addAttentionSource: (value) => {
        if (value.id === "command") run = value.run;
      },
    },
    host: {
      spawn: async (_id, options) => {
        const child = spawn("bash", [
          "-c",
          'exec "$@"',
          "attention",
          ...options.args,
        ]);
        child.stdout.setEncoding("utf8").on("data", options.onStdout);
        child.stderr.setEncoding("utf8").on("data", options.onStderr);
        return {
          write: async () => {},
          end: async () => {},
          kill: async () => {
            child.kill();
          },
          exited: new Promise((resolve, reject) => {
            child.on("exit", resolve);
            child.on("error", reject);
          }),
        };
      },
    },
  });
  const emit = vi.fn();
  await run({
    agent: "a",
    watch: {
      config: { command: ["python3", "-u", "-c", 'print("PR changed")'] },
    },
    signal: new AbortController().signal,
    emit,
  });
  expect(emit).toHaveBeenCalledTimes(1);
  expect(emit).toHaveBeenCalledWith("PR changed\n");
});
