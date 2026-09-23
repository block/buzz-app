import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectorClient,
  normalizeWebViteArgs,
  safeUrl,
} from "../../scripts/profile-dev.mjs";

test("web profiling canonicalizes its Vite port and strict-port contract", () => {
  assert.deepEqual(
    normalizeWebViteArgs(["--host", "127.0.0.1", "--port=1431"]),
    {
      port: 1431,
      args: ["--host", "127.0.0.1", "--port", "1431", "--strictPort"],
    },
  );
  assert.throws(
    () => normalizeWebViteArgs(["--port", "1431", "--port", "1432"]),
    /only one --port/,
  );
  assert.throws(
    () => normalizeWebViteArgs(["--no-strictPort"]),
    /requires --strictPort/,
  );
});

test("network URLs redact opaque payloads and strip HTTP secrets", () => {
  assert.equal(safeUrl("data:text/plain,PRIVATE_BODY"), "data:<redacted>");
  assert.equal(
    safeUrl("https://user:password@example.com/path?q=secret#fragment"),
    "https://example.com/path",
  );
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
