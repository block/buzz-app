import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  inspectorClient,
  normalizeWebViteArgs,
  safeUrl,
  viteListenerUrl,
  viteReadyToken,
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

test("web profiling derives navigation from its owned listener", () => {
  assert.equal(
    viteListenerUrl({ address: "127.0.0.1", port: 1430 }),
    "http://127.0.0.1:1430",
  );
  assert.equal(
    viteListenerUrl({ address: "::1", port: 1430 }),
    "http://[::1]:1430",
  );
  assert.equal(
    viteListenerUrl({ address: "::", port: 1430 }),
    "http://[::1]:1430",
  );
});

test("web profiling waits for its authenticated Vite listening marker", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const abort = new AbortController();
  const ready = viteReadyToken(child, "owned-token", abort.signal);

  child.stdout.emit(
    "data",
    'BUZZ_PROFILE_VITE_READY:other-token:{"address":"::1","port":1430}\n',
  );
  let settled = false;
  void ready.then(() => (settled = true));
  await Promise.resolve();
  assert.equal(settled, false);

  child.stderr.emit(
    "data",
    'BUZZ_PROFILE_VITE_READY:owned-token:{"address":"127.0.0.1","port":1430}\n',
  );
  assert.equal(await ready, "http://127.0.0.1:1430");
});

test("web profiling rejects Vite bind failure before readiness", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const ready = viteReadyToken(
    child,
    "owned-token",
    new AbortController().signal,
  );
  child.stderr.emit("data", "Error: Port 1430 is already in use\n");
  await assert.rejects(ready, /could not bind/);
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
