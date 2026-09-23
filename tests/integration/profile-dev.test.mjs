import assert from "node:assert/strict";
import test from "node:test";
import { inspectorClient, webViteArgs } from "../../scripts/profile-dev.mjs";

test("web profiling requires the requested Vite port", () => {
  assert.deepEqual(webViteArgs(["--port", "1431"]), [
    "--port",
    "1431",
    "--strictPort",
  ]);
  assert.deepEqual(webViteArgs(["--strictPort"]), ["--strictPort"]);
});

test("inspector requests reject after the transport closes", async () => {
  const original = globalThis.WebSocket;
  class ClosedSocket extends EventTarget {
    send() {}
    close() {
      this.dispatchEvent(new Event("close"));
    }
  }
  globalThis.WebSocket = ClosedSocket;
  try {
    const client = inspectorClient("ws://inspector.invalid");
    const request = client.send("Profiler.stop");
    await Promise.resolve();
    client.close();
    await assert.rejects(request, /Node inspector connection closed/);
    await assert.rejects(
      client.send("Profiler.stop"),
      /Node inspector connection closed/,
    );
  } finally {
    globalThis.WebSocket = original;
  }
});
