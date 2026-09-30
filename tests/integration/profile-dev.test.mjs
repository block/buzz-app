import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { fork } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  inspectorClient,
  normalizeWebViteArgs,
  safeUrl,
  takeScenario,
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
    () => normalizeWebViteArgs(["--host"]),
    /requires --host 127\.0\.0\.1/,
  );
  assert.throws(
    () => normalizeWebViteArgs(["--host", "0.0.0.0"]),
    /requires --host 127\.0\.0\.1/,
  );
  assert.throws(
    () => normalizeWebViteArgs(["--host=::1"]),
    /requires --host 127\.0\.0\.1/,
  );
  assert.throws(
    () => normalizeWebViteArgs(["--no-strictPort"]),
    /requires --strictPort/,
  );
});

test("profiling takes one known scenario and leaves the other arguments", () => {
  for (const values of [
    ["--port", "1431", "--scenario", "channels"],
    ["--scenario=channels", "--port", "1431"],
  ])
    assert.deepEqual(takeScenario(values), {
      scenario: "channels",
      args: ["--port", "1431"],
    });
  assert.deepEqual(takeScenario(["--port", "1431"]), {
    scenario: undefined,
    args: ["--port", "1431"],
  });
  for (const values of [["--scenario"], ["--scenario=toString"]])
    assert.throws(() => takeScenario(values), /must be one of: channels/);
  assert.throws(
    () => takeScenario(["--scenario", "channels", "--scenario=channels"]),
    /only one --scenario/,
  );
});

test("web profiling derives navigation from its owned listener", () => {
  assert.equal(
    viteListenerUrl({ address: "127.0.0.1", port: 1430 }),
    "http://127.0.0.1:1430",
  );
  assert.throws(
    () => viteListenerUrl({ address: "::1", port: 1430 }),
    /required profiling host/,
  );
  assert.throws(
    () => viteListenerUrl({ address: "0.0.0.0", port: 1430 }),
    /required profiling host/,
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

async function webFixture(t, scenario) {
  const directory = await mkdtemp(path.join(tmpdir(), "buzz-profile-web-"));
  const fixtures = new URL("./fixtures/profile-web/", import.meta.url);
  for (const name of [
    "scripts",
    "node_modules/vite/bin",
    "node_modules/@playwright/test",
    "profiles",
  ])
    await mkdir(path.join(directory, name), { recursive: true });
  await copyFile(
    new URL("../../scripts/profile-dev.mjs", import.meta.url),
    path.join(directory, "scripts/profile-dev.mjs"),
  );
  for (const [source, destination] of [
    ["driver.mjs", "driver.mjs"],
    ["vite.mjs", "node_modules/vite/bin/vite.js"],
    ["browser.mjs", "node_modules/@playwright/test/index.mjs"],
  ])
    await copyFile(
      new URL(source, fixtures),
      path.join(directory, destination),
    );
  await writeFile(
    path.join(directory, "node_modules/@playwright/test/package.json"),
    JSON.stringify({ type: "module", exports: "./index.mjs" }),
  );
  const child = fork(path.join(directory, "driver.mjs"), [], {
    cwd: directory,
    env: {
      PATH: process.env.PATH,
      BUZZ_RELAY_URL: "wss://relay.example",
      BUZZ_TEST_SCENARIO: JSON.stringify(scenario),
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const messages = [];
  const events = new EventEmitter();
  let log = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      log += chunk;
    });
  child.on("message", (message) => {
    messages.push(message);
    events.emit("message");
  });
  const exited = once(child, "exit");
  const wait = async (type) => {
    const signal = AbortSignal.timeout(10_000);
    while (!messages.some((message) => message.type === type)) {
      try {
        await once(events, "message", { signal });
      } catch (error) {
        throw new Error(
          `Missing ${type}: ${JSON.stringify(messages)}\n${log}`,
          { cause: error },
        );
      }
    }
    return messages.find((message) => message.type === type);
  };
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await exited;
    // Only the fixture-owned Vite group may need emergency cleanup on a failed assertion.
    const pid = Number(
      await readFile(path.join(directory, "vite.pid"), "utf8").catch(() => "0"),
    );
    if (pid) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    await rm(directory, { recursive: true, force: true });
  });
  return { child, directory, messages, wait, exited, log: () => log };
}

for (const held of [
  "launch",
  "newPage",
  "newCDPSession",
  "Network.enable",
  "Performance.enable",
  "Performance.getMetrics",
  "evaluate",
  "Profiler.enable",
  "Profiler.setSamplingInterval",
  "Profiler.start",
  "startTracing",
  "goto",
]) {
  for (const late of ["resolve", "reject"]) {
    test(`web startup cancels held ${held} before late ${late}`, async (t) => {
      const fixture = await webFixture(t, {
        held,
        late,
        trace: held === "startTracing",
      });
      await fixture.wait("held");
      fixture.child.kill("SIGINT");
      // Cleanup must finish without releasing the stalled startup operation.
      const settled = await fixture.wait("settled");
      assert.match(settled.error, /stopped during startup/);
      if (held !== "launch") await fixture.wait("browserClosed");
      const pid = Number(
        await readFile(path.join(fixture.directory, "vite.pid"), "utf8"),
      );
      assert.throws(() => process.kill(-pid, 0), { code: "ESRCH" });
      const calls = fixture.messages.filter(({ type }) => type === "call");
      fixture.child.send("release");
      await fixture.wait("released");
      if (held === "launch" && late === "resolve")
        await fixture.wait("browserClosed");
      fixture.child.send("finish");
      assert.deepEqual(await fixture.exited, [1, null], fixture.log());
      assert.deepEqual(
        fixture.messages.filter(({ type }) => type === "call"),
        calls,
        "late completion resumed startup",
      );
      assert.equal(
        fixture.messages.some(({ type }) => type === "navigated"),
        false,
      );
      assert.doesNotMatch(
        fixture.log(),
        /Profile saved to|fixture late rejection/,
      );
    });
  }
}

for (const reject of ["launch", "newPage", "newCDPSession"]) {
  test(`web startup cleans up ${reject} rejection`, async (t) => {
    const fixture = await webFixture(t, { reject });
    const settled = await fixture.wait("settled");
    assert.match(settled.error, /stopped during startup/);
    assert.match(settled.cause, /fixture rejection/);
    if (reject !== "launch") await fixture.wait("browserClosed");
    fixture.child.send("finish");
    assert.deepEqual(await fixture.exited, [1, null], fixture.log());
    assert.equal(
      fixture.messages.some(({ type }) => type === "navigated"),
      false,
    );
  });
}

test("web capture still finalizes renderer, broker, and network artifacts on Ctrl-C", async (t) => {
  const fixture = await webFixture(t, {});
  await fixture.wait("capturing");
  fixture.child.kill("SIGINT");
  assert.equal((await fixture.wait("settled")).error, undefined);
  await fixture.wait("browserClosed");
  fixture.child.send("finish");
  assert.deepEqual(await fixture.exited, [0, null], fixture.log());
  assert.deepEqual(
    (await readdir(path.join(fixture.directory, "profiles"))).sort(),
    [
      "chromium-renderer.cpuprofile",
      "manifest.json",
      "network.json",
      "vite-broker.cpuprofile",
    ],
  );
  for (const name of ["chromium-renderer", "vite-broker"]) {
    const profile = JSON.parse(
      await readFile(
        path.join(fixture.directory, `profiles/${name}.cpuprofile`),
        "utf8",
      ),
    );
    assert.ok(profile.nodes.length > 0);
    assert.ok(profile.endTime >= profile.startTime);
  }
  assert.match(fixture.log(), /Profile saved to/);
});

test("traced web capture replaces the renderer profile with a DevTools trace", async (t) => {
  const fixture = await webFixture(t, { trace: true });
  await fixture.wait("capturing");
  fixture.child.kill("SIGINT");
  assert.equal((await fixture.wait("settled")).error, undefined);
  await fixture.wait("browserClosed");
  fixture.child.send("finish");
  assert.deepEqual(await fixture.exited, [0, null], fixture.log());
  const calls = fixture.messages
    .filter(({ type }) => type === "call")
    .map(({ name }) => name);
  assert.equal(calls.includes("Profiler.start"), false);
  assert.ok(calls.indexOf("stopTracing") > calls.indexOf("startTracing"));
  assert.deepEqual(
    (await readdir(path.join(fixture.directory, "profiles"))).sort(),
    [
      "chromium-trace.json",
      "manifest.json",
      "network.json",
      "vite-broker.cpuprofile",
    ],
  );
  assert.deepEqual(
    JSON.parse(
      await readFile(
        path.join(fixture.directory, "profiles/chromium-trace.json"),
        "utf8",
      ),
    ),
    { traceEvents: [] },
  );
  assert.deepEqual(
    JSON.parse(
      await readFile(
        path.join(fixture.directory, "profiles/manifest.json"),
        "utf8",
      ),
    ).coverage,
    ["chromium-trace", "vite-broker", "chromium-network"],
  );
});

const profileFiles = async (fixture) =>
  (await readdir(path.join(fixture.directory, "profiles"))).sort();

test("a scenario ends its own capture and saves the app's client metrics", async (t) => {
  const fixture = await webFixture(t, { scenario: "channels" });
  assert.equal((await fixture.wait("settled")).error, undefined);
  await fixture.wait("browserClosed");
  fixture.child.send("finish");
  assert.deepEqual(await fixture.exited, [0, null], fixture.log());
  const calls = fixture.messages
    .filter(({ type }) => type === "call")
    .map(({ name }) => name);
  // The opened channel is current on the second pass and is not reselected.
  assert.equal(calls.filter((name) => name === "click").length, 1);
  assert.ok(calls.indexOf("Profiler.stop") > calls.lastIndexOf("evaluate"));
  assert.deepEqual(await profileFiles(fixture), [
    "chromium-renderer.cpuprofile",
    "client-metrics.json",
    "manifest.json",
    "network.json",
    "vite-broker.cpuprofile",
  ]);
  const manifest = JSON.parse(
    await readFile(
      path.join(fixture.directory, "profiles/manifest.json"),
      "utf8",
    ),
  );
  assert.equal(manifest.scenario, "channels");
  assert.equal(manifest.relay, "wss://relay.example");
  assert.ok(manifest.coverage.includes("client-metrics"));
});

test("a failed scenario step finalizes the capture without client metrics", async (t) => {
  const fixture = await webFixture(t, {
    scenario: "channels",
    reject: "click",
  });
  assert.match((await fixture.wait("settled")).error, /fixture rejection/);
  await fixture.wait("browserClosed");
  fixture.child.send("finish");
  assert.deepEqual(await fixture.exited, [1, null], fixture.log());
  assert.deepEqual(await profileFiles(fixture), [
    "chromium-renderer.cpuprofile",
    "manifest.json",
    "network.json",
    "vite-broker.cpuprofile",
  ]);
});

test("Ctrl-C during a scenario saves the capture without client metrics", async (t) => {
  const fixture = await webFixture(t, {
    scenario: "channels",
    held: "click",
    late: "resolve",
  });
  await fixture.wait("held");
  fixture.child.kill("SIGINT");
  assert.equal((await fixture.wait("settled")).error, undefined);
  await fixture.wait("browserClosed");
  // The interrupted scenario may still finish; it must not report completion.
  fixture.child.send("release");
  await fixture.wait("released");
  fixture.child.send("finish");
  assert.deepEqual(await fixture.exited, [0, null], fixture.log());
  assert.equal(
    (await profileFiles(fixture)).includes("client-metrics.json"),
    false,
  );
});
