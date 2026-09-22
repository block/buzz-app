import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import process from "node:process";

const root = fileURLToPath(new URL("../", import.meta.url));
const target = process.argv[2];
const profileArgs = process.argv.slice(3);
const network = target === "web" && profileArgs.includes("--network");
const args = profileArgs.filter((argument) => argument !== "--network");
if (target !== "web" && target !== "desktop") {
  console.error(
    "Usage: node scripts/profile-dev.mjs <web|desktop> [arguments]",
  );
  process.exit(1);
}
if (process.platform !== "darwin") {
  console.error("Development profiling currently supports macOS only.");
  process.exit(1);
}

const stamp = new Date()
  .toISOString()
  .replaceAll(":", "-")
  .replace(/\.\d{3}Z$/, "Z");
const directory = `${root}.profiles/${stamp}-${target}`;
await mkdir(directory, { recursive: true });

const children = new Set();
let stopping;
let forced = false;

function run(command, commandArgs, options = {}) {
  const child = spawn(command, commandArgs, {
    cwd: root,
    stdio: "inherit",
    detached: true,
    ...options,
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

function mirror(child) {
  child.stdout?.pipe(process.stdout);
  child.stderr?.pipe(process.stderr);
}

function waitForInspector(child) {
  return new Promise((resolve, reject) => {
    let pending = "";
    const onData = (chunk) => {
      pending += chunk;
      const match = pending.match(/Debugger listening on (ws:\/\/\S+)/);
      if (match) {
        child.stderr.off("data", onData);
        resolve(match[1]);
      }
      if (pending.length > 16_384) pending = pending.slice(-8_192);
    };
    child.stderr.on("data", onData);
    child.once("exit", () =>
      reject(new Error("Vite exited before its Node inspector became ready.")),
    );
  });
}

async function commandSucceeds(command, commandArgs) {
  return await new Promise((resolve) => {
    const child = spawn(command, commandArgs, {
      cwd: root,
      stdio: "ignore",
    });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
}

function inspectorClient(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 1;
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (!message.id) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error(`Could not connect to Node inspector at ${url}.`)),
      { once: true },
    );
  });
  return {
    async send(method, params) {
      await ready;
      return await new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      socket.close();
    },
  };
}

function signal(child, name) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  try {
    process.kill(-child.pid, name);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function output(command, commandArgs) {
  return await new Promise((resolve) => {
    const child = spawn(command, commandArgs, {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let value = "";
    child.stdout.on("data", (chunk) => (value += chunk));
    child.once("close", () => resolve(value.trim()));
  });
}

async function recordManifest(extra = {}) {
  await writeFile(
    `${directory}/manifest.json`,
    `${JSON.stringify(
      {
        target,
        startedAt: new Date().toISOString(),
        git: {
          commit: await output("git", ["rev-parse", "HEAD"]),
          dirty: Boolean(await output("git", ["status", "--porcelain"])),
        },
        platform: `${process.platform}-${process.arch}`,
        node: process.version,
        arguments: profileArgs,
        ...extra,
      },
      null,
      2,
    )}\n`,
  );
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function stopChildren() {
  for (const child of children) signal(child, "SIGINT");
  await Promise.race([
    Promise.all([...children].map((child) => waitForExit(child, 30_000))),
    new Promise((resolve) => setTimeout(resolve, 30_000)),
  ]);
  for (const child of children) signal(child, "SIGTERM");
}

function installSignals(stop) {
  for (const name of ["SIGINT", "SIGTERM"]) {
    process.on(name, () => {
      if (stopping) {
        forced = true;
        for (const child of children) signal(child, "SIGKILL");
        return;
      }
      stopping = Promise.resolve()
        .then(stop)
        .catch((error) => {
          console.error(error);
          process.exitCode = 1;
        });
    });
  }
}

function vitePort(values) {
  for (let index = 0; index < values.length; index++) {
    if (values[index] === "--port") return Number(values[index + 1]);
    if (values[index].startsWith("--port="))
      return Number(values[index].slice(7));
  }
  return 1430;
}

async function waitForServer(url, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`Vite exited before ${url} became ready.`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${url}.`);
}

function safeUrl(value) {
  const url = new URL(value);
  return `${url.origin}${url.pathname}`;
}

function networkRecorder(session) {
  const requests = new Map();
  const webSockets = new Map();
  const startedAt = new Date().toISOString();
  let calibration;

  session.on(
    "Network.requestWillBeSent",
    ({ requestId, request, timestamp, type }) => {
      requests.set(requestId, {
        requestId,
        method: request.method,
        type,
        url: safeUrl(request.url),
        start: timestamp,
      });
    },
  );
  session.on(
    "Network.responseReceived",
    ({ requestId, response, timestamp, type }) => {
      const entry = requests.get(requestId);
      if (!entry) return;
      entry.type = type;
      entry.status = response.status;
      entry.protocol = response.protocol;
      entry.remoteAddress = response.remoteIPAddress
        ? `${response.remoteIPAddress}:${response.remotePort}`
        : undefined;
      entry.response = timestamp;
      entry.timing = response.timing;
      entry.serverTiming = response.headers?.["server-timing"];
    },
  );
  session.on(
    "Network.loadingFinished",
    ({ requestId, timestamp, encodedDataLength }) => {
      const entry = requests.get(requestId);
      if (!entry) return;
      entry.end = timestamp;
      entry.encodedDataLength = encodedDataLength;
    },
  );
  session.on(
    "Network.loadingFailed",
    ({ requestId, timestamp, errorText, canceled }) => {
      const entry = requests.get(requestId);
      if (!entry) return;
      entry.end = timestamp;
      entry.failure = { errorText, canceled };
    },
  );
  session.on("Network.webSocketCreated", ({ requestId, url }) => {
    webSockets.set(requestId, { requestId, url: safeUrl(url), frames: [] });
  });
  session.on(
    "Network.webSocketWillSendHandshakeRequest",
    ({ requestId, timestamp }) => {
      const entry = webSockets.get(requestId);
      if (entry) entry.start = timestamp;
    },
  );
  session.on(
    "Network.webSocketHandshakeResponseReceived",
    ({ requestId, timestamp, response }) => {
      const entry = webSockets.get(requestId);
      if (!entry) return;
      entry.handshake = timestamp;
      entry.status = response.status;
    },
  );
  for (const [event, direction] of [
    ["Network.webSocketFrameSent", "sent"],
    ["Network.webSocketFrameReceived", "received"],
  ]) {
    session.on(event, ({ requestId, timestamp, response }) => {
      const entry = webSockets.get(requestId);
      if (!entry) return;
      entry.frames.push({
        direction,
        timestamp,
        opcode: response.opcode,
        bytes: response.payloadData.length,
      });
    });
  }
  session.on("Network.webSocketClosed", ({ requestId, timestamp }) => {
    const entry = webSockets.get(requestId);
    if (entry) entry.end = timestamp;
  });

  return {
    async start(page) {
      await session.send("Network.enable", { maxPostDataSize: 0 });
      await session.send("Performance.enable");
      const { metrics } = await session.send("Performance.getMetrics");
      calibration = {
        cdpMonotonicSeconds: metrics.find(({ name }) => name === "Timestamp")
          ?.value,
        renderer: await page.evaluate(() => ({
          epochMilliseconds: performance.timeOrigin + performance.now(),
          monotonicMilliseconds: performance.now(),
        })),
      };
    },
    async write(clocks) {
      await writeFile(
        `${directory}/network.json`,
        `${JSON.stringify(
          {
            format: "buzz-network-profile-v1",
            startedAt,
            calibration: { ...calibration, cpuProfiles: clocks },
            privacy:
              "URLs exclude query/fragment; headers exclude everything except Server-Timing; bodies and frame payloads are omitted.",
            requests: [...requests.values()],
            webSockets: [...webSockets.values()],
          },
          null,
          2,
        )}\n`,
      );
    },
  };
}

async function writeProtocolStream(session, handle, destination) {
  const output = createWriteStream(destination);
  try {
    for (;;) {
      const { data, base64Encoded, eof } = await session.send("IO.read", {
        handle,
      });
      output.write(data, base64Encoded ? "base64" : "utf8");
      if (eof) break;
    }
    await session.send("IO.close", { handle });
  } finally {
    await new Promise((resolve, reject) => {
      output.once("error", reject);
      output.end(resolve);
    });
  }
}

async function profileWeb() {
  const port = vitePort(args);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("--port must be an integer between 1 and 65535.");
  const url = `http://localhost:${port}`;
  await recordManifest({
    coverage: [
      "chromium-renderer",
      "vite-broker",
      ...(network ? ["chromium-network"] : []),
    ],
    network,
  });
  const nodeOptions = [process.env.NODE_OPTIONS, "--inspect=127.0.0.1:0"]
    .filter(Boolean)
    .join(" ");
  const vite = run(
    process.execPath,
    ["node_modules/vite/bin/vite.js", ...args],
    {
      env: { ...process.env, NODE_OPTIONS: nodeOptions },
      stdio: ["inherit", "pipe", "pipe"],
    },
  );
  const inspectorUrl = waitForInspector(vite);
  mirror(vite);
  let browser;
  let session;
  let networkCapture;
  let tracingComplete;
  let nodeProfiler;
  const stop = async () => {
    let failure;
    try {
      let rendererProfile;
      let brokerProfile;
      if (session) {
        ({ profile: rendererProfile } = await session.send("Profiler.stop"));
        await writeFile(
          `${directory}/chromium-renderer.cpuprofile`,
          `${JSON.stringify(rendererProfile)}\n`,
        );
      }
      if (nodeProfiler) {
        ({ profile: brokerProfile } = await nodeProfiler.send("Profiler.stop"));
        await writeFile(
          `${directory}/vite-broker.cpuprofile`,
          `${JSON.stringify(brokerProfile)}\n`,
        );
      }
      if (networkCapture) {
        await networkCapture.write({
          renderer: rendererProfile && {
            startTimeMicroseconds: rendererProfile.startTime,
            endTimeMicroseconds: rendererProfile.endTime,
          },
          broker: brokerProfile && {
            startTimeMicroseconds: brokerProfile.startTime,
            endTimeMicroseconds: brokerProfile.endTime,
            note: "Node inspector monotonic epoch is isolate-specific; align by capture start/end rather than assuming the renderer epoch.",
          },
        });
        const complete = tracingComplete;
        await session.send("Tracing.end");
        const { stream } = await complete;
        await writeProtocolStream(
          session,
          stream,
          `${directory}/chrome-performance.json`,
        );
      }
    } catch (error) {
      failure = error;
    } finally {
      nodeProfiler?.close();
      await browser?.close();
      await stopChildren();
    }
    if (failure) throw failure;
    console.log(`\nProfile saved to ${directory}`);
    run("open", [directory]);
    process.exitCode = forced ? 130 : 0;
  };
  installSignals(stop);
  await waitForServer(url, vite);
  nodeProfiler = inspectorClient(await inspectorUrl);
  await nodeProfiler.send("Profiler.enable");
  await nodeProfiler.send("Profiler.setSamplingInterval", { interval: 1000 });
  await nodeProfiler.send("Profiler.start");
  const { chromium } = await import("@playwright/test");
  browser = await chromium.launch({
    channel: "chrome",
    headless: false,
    handleSIGINT: false,
    handleSIGTERM: false,
  });
  const page = await browser.newPage();
  session = await page.context().newCDPSession(page);
  if (network) {
    networkCapture = networkRecorder(session);
    await networkCapture.start(page);
    tracingComplete = new Promise((resolve) =>
      session.once("Tracing.tracingComplete", resolve),
    );
    await session.send("Tracing.start", {
      categories: [
        "devtools.timeline",
        "v8.execute",
        "loading",
        "disabled-by-default-devtools.timeline",
        "disabled-by-default-devtools.timeline.frame",
        "disabled-by-default-v8.cpu_profiler",
        "disabled-by-default-v8.cpu_profiler.hires",
      ].join(","),
      options: "sampling-frequency=10000",
      transferMode: "ReturnAsStream",
    });
  }
  await session.send("Profiler.enable");
  await session.send("Profiler.setSamplingInterval", { interval: 1000 });
  await session.send("Profiler.start");
  await page.goto(url);
  console.log(`\nProfiling ${url}. Press Ctrl-C to stop and open the results.`);
  const code = await new Promise((resolve) =>
    vite.once("exit", (value) => resolve(value ?? 0)),
  );
  if (!stopping) {
    await stop();
    process.exitCode = code;
  }
}

async function profileDesktop() {
  const trace = `${directory}/desktop-time-profile.trace`;
  await recordManifest({
    coverage: ["all-native-processes"],
    caveat: "JavaScriptCore stacks may not resolve to application JavaScript.",
  });
  run("xcrun", [
    "xctrace",
    "record",
    "--template",
    "Time Profiler",
    "--all-processes",
    "--output",
    trace,
    "--no-prompt",
  ]);
  let desktop;
  const stop = async () => {
    await stopChildren();
    if (
      !(await commandSucceeds("xcrun", [
        "xctrace",
        "export",
        "--input",
        trace,
        "--toc",
      ]))
    ) {
      throw new Error(
        `Instruments left an incomplete trace at ${trace}; rerun and press Ctrl-C only once.`,
      );
    }
    console.log(`\nProfile saved to ${trace}`);
    run("open", [trace]);
    process.exitCode = forced ? 130 : 0;
  };
  installSignals(stop);
  // xctrace has no machine-readable readiness event without coupling to a custom notification.
  // Start compilation immediately: Time Profiler records system-wide, including processes created afterward.
  desktop = run(process.execPath, ["scripts/desktop-dev.mjs", ...args]);
  console.log(
    "\nProfiling the desktop process tree. Press Ctrl-C to stop and open Instruments.",
  );
  const code = await new Promise((resolve) =>
    desktop.once("exit", (value) => resolve(value ?? 0)),
  );
  if (!stopping) {
    await stop();
    process.exitCode = code;
  }
}

try {
  if (target === "web") await profileWeb();
  else await profileDesktop();
  await stopping;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  await stopChildren();
  process.exitCode = 1;
}
