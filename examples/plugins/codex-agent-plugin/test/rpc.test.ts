import { expect, it, vi } from "vitest";
import { AppServer, type Connect } from "../src/rpc.ts";
it("rejects outstanding turns on process exit and does not accept late replies", async () => {
  let receive!: (line: string) => void;
  let exited!: (error: Error) => void;
  const sent: { id: number }[] = [];
  const connect: Connect = async (_id, options) => {
    receive = options.onLine;
    exited = options.onClose;
    return {
      close() {},
      async send(text) {
        const message = JSON.parse(text);
        sent.push(message);
        if (message.method === "initialize")
          receive(JSON.stringify({ id: message.id, result: {} }));
      },
    };
  };
  const rpc = await new AppServer().open(connect, new AbortController().signal);
  const pending = rpc.request("turn/start");
  const rejected = expect(pending).rejects.toThrow("process died");
  exited(new Error("process died"));
  await rejected;
  receive(
    JSON.stringify({ id: sent.at(-1)?.id, result: { turn: { id: "late" } } }),
  );
  await expect(rpc.request("turn/start")).rejects.toThrow("process died");
  rpc.close();
});
it("bounds a nonresponsive protocol request with a controlled deadline", async () => {
  vi.useFakeTimers();
  const rpc = new AppServer();
  try {
    const opening = rpc.open(
      async () => ({ send: async () => {}, close() {} }),
      new AbortController().signal,
    );
    const failure = expect(opening).rejects.toThrow("initialize timed out");
    await vi.advanceTimersByTimeAsync(30_000);
    await failure;
  } finally {
    rpc.close();
    vi.useRealTimers();
  }
});
