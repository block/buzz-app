import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import process from "node:process";

const root = fileURLToPath(new URL("../", import.meta.url));

const children = new Set();
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

export function waitForInspector(child) {
  return new Promise((resolve, reject) => {
    let pending = "";
    const onData = (chunk) => {
      pending += chunk;
      const match = pending.match(/Debugger listening on (ws:\/\/\S+)/);
      if (match) {
        cleanup();
        resolve(match[1]);
      }
      if (pending.length > 16_384) pending = pending.slice(-8_192);
    };
    const onExit = () => {
      cleanup();
      reject(new Error("Vite exited before its Node inspector became ready."));
    };
    const cleanup = () => {
      child.stderr.off("data", onData);
      child.off("exit", onExit);
    };
    child.stderr.on("data", onData);
    child.once("exit", onExit);
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

export function inspectorClient(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 1;
  let terminalError;
  const fail = (error) => {
    if (terminalError) return;
    terminalError = error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (!message.id) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    rejectReady = reject;
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener(
      "error",
      () => {
        const error = new Error(
          `Could not connect to Node inspector at ${url}.`,
        );
        fail(error);
        reject(error);
      },
      { once: true },
    );
  });
  socket.addEventListener("close", () => {
    const error = new Error("Node inspector connection closed.");
    fail(error);
    rejectReady(error);
  });
  return {
    async send(method, params) {
      await ready;
      if (terminalError) throw terminalError;
      return await new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        try {
          socket.send(JSON.stringify({ id, method, params }));
        } catch (error) {
          pending.delete(id);
          reject(error);
        }
      });
    },
    close() {
      const error = new Error("Node inspector connection closed.");
      fail(error);
      rejectReady(error);
      socket.close();
    },
  };
}

function signal(child, name) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  try {
    const desktopLauncher = child.spawnargs?.includes(
      "scripts/desktop-dev.mjs",
    );
    process.kill(desktopLauncher ? child.pid : -child.pid, name);
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

async function recordManifest(directory, target, profileArgs, extra = {}) {
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

function stopController() {
  const abort = new AbortController();
  let resolve;
  const requested = new Promise((value) => (resolve = value));
  for (const name of ["SIGINT", "SIGTERM"]) {
    process.on(name, () => {
      if (abort.signal.aborted) {
        forced = true;
        for (const child of children) signal(child, "SIGKILL");
        return;
      }
      console.log(
        `\n${name === "SIGINT" ? "Ctrl-C" : name} received; finalizing profile...`,
      );
      abort.abort();
      resolve({ reason: "signal", code: 0 });
    });
  }
  return { abort, requested };
}

function vitePort(values) {
  for (let index = 0; index < values.length; index++) {
    if (values[index] === "--port") return Number(values[index + 1]);
    if (values[index].startsWith("--port="))
      return Number(values[index].slice(7));
  }
  return 1430;
}

async function waitForServer(url, child, signal) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (child.exitCode !== null)
      throw new Error(`Vite exited before ${url} became ready.`);
    try {
      const response = await fetch(url, { signal });
      if (response.ok) return;
    } catch (error) {
      if (signal.aborted) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${url}.`);
}

function safeUrl(value) {
  const url = new URL(value);
  return `${url.origin}${url.pathname}`;
}

function headerValue(headers, name) {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers ?? {}))
    if (key.toLowerCase() === target) return value;
  return undefined;
}

export function networkRecorder(session, directory) {
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
      entry.serverTiming = headerValue(response.headers, "server-timing");
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

export function webViteArgs(values) {
  return values.includes("--strictPort") ? values : [...values, "--strictPort"];
}

async function profileWeb({ directory, profileArgs, args, network }) {
  const port = vitePort(args);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("--port must be an integer between 1 and 65535.");
  const url = `http://localhost:${port}`;
  await recordManifest(directory, "web", profileArgs, {
    coverage: [
      "chromium-renderer",
      "vite-broker",
      ...(network ? ["chromium-network"] : []),
    ],
    network,
  });

  const control = stopController();
  const cancelled = control.requested.then(() => {
    throw new DOMException("Profiling startup cancelled.", "AbortError");
  });
  const nodeOptions = [process.env.NODE_OPTIONS, "--inspect=127.0.0.1:0"]
    .filter(Boolean)
    .join(" ");
  const vite = run(
    process.execPath,
    ["node_modules/vite/bin/vite.js", ...webViteArgs(args)],
    {
      env: { ...process.env, NODE_OPTIONS: nodeOptions },
      stdio: ["inherit", "pipe", "pipe"],
    },
  );
  const inspectorUrl = waitForInspector(vite);
  const viteExit = new Promise((resolve) =>
    vite.once("exit", (code, signal) =>
      resolve({ reason: "vite", code: code ?? (signal ? 1 : 0) }),
    ),
  );
  mirror(vite);

  let browser;
  let session;
  let networkCapture;
  let nodeProfiler;
  let rendererStarted = false;
  let brokerStarted = false;
  let captureStarted = false;
  let outcome;
  const failures = [];
  try {
    await waitForServer(url, vite, control.abort.signal);
    control.abort.signal.throwIfAborted();
    nodeProfiler = inspectorClient(
      await Promise.race([inspectorUrl, cancelled]),
    );
    await nodeProfiler.send("Profiler.enable");
    await nodeProfiler.send("Profiler.setSamplingInterval", { interval: 1000 });
    await nodeProfiler.send("Profiler.start");
    brokerStarted = true;
    control.abort.signal.throwIfAborted();

    const { chromium } = await import("@playwright/test");
    const browserLaunch = chromium.launch({
      channel: "chrome",
      headless: false,
      handleSIGINT: false,
      handleSIGTERM: false,
    });
    void browserLaunch.then((launched) => {
      if (control.abort.signal.aborted && launched !== browser)
        return launched.close();
    });
    browser = await Promise.race([browserLaunch, cancelled]);
    control.abort.signal.throwIfAborted();
    const page = await browser.newPage();
    session = await page.context().newCDPSession(page);
    if (network) {
      networkCapture = networkRecorder(session, directory);
      await networkCapture.start(page);
    }
    await session.send("Profiler.enable");
    await session.send("Profiler.setSamplingInterval", { interval: 1000 });
    await session.send("Profiler.start");
    rendererStarted = true;
    await page.goto(url);
    control.abort.signal.throwIfAborted();
    captureStarted = true;
    console.log(
      `\nProfiling ${url}. Press Ctrl-C to stop and save the profile.`,
    );
    outcome = await Promise.race([control.requested, viteExit]);
  } catch (error) {
    if (!control.abort.signal.aborted) failures.push(error);
    outcome ??= { reason: "startup", code: 1 };
  } finally {
    let rendererProfile;
    let brokerProfile;
    if (rendererStarted) {
      try {
        ({ profile: rendererProfile } = await session.send("Profiler.stop"));
        await writeFile(
          `${directory}/chromium-renderer.cpuprofile`,
          `${JSON.stringify(rendererProfile)}\n`,
        );
      } catch (error) {
        failures.push(error);
      }
    }
    if (brokerStarted) {
      try {
        ({ profile: brokerProfile } = await nodeProfiler.send("Profiler.stop"));
        await writeFile(
          `${directory}/vite-broker.cpuprofile`,
          `${JSON.stringify(brokerProfile)}\n`,
        );
      } catch (error) {
        failures.push(error);
      }
    }
    if (networkCapture) {
      try {
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
      } catch (error) {
        failures.push(error);
      }
    }
    nodeProfiler?.close();
    try {
      await browser?.close();
    } catch (error) {
      failures.push(error);
    }
    await stopChildren();
  }

  if (!captureStarted) {
    throw new Error(
      `Profiling stopped during startup; partial artifacts remain at ${directory}.`,
      { cause: failures[0] },
    );
  }
  if (failures.length) throw failures[0];
  console.log(`\nProfile saved to ${directory}`);
  process.exitCode = forced ? 130 : (outcome?.code ?? 0);
}

function hasRunnerArgument(values) {
  return values.some(
    (value) =>
      value === "--runner" || value === "-r" || value.startsWith("--runner="),
  );
}

async function waitForTrace(trace) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (
      await commandSucceeds("xcrun", [
        "xctrace",
        "export",
        "--input",
        trace,
        "--toc",
      ])
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Instruments left an incomplete trace at ${trace}; rerun and press Ctrl-C only once.`,
  );
}

async function profileDesktop({ directory, profileArgs, args }) {
  if (hasRunnerArgument(args))
    throw new Error("Desktop profiling owns Tauri's --runner option.");
  const trace = `${directory}/desktop-time-profile.trace`;
  await recordManifest(directory, "desktop", profileArgs, {
    coverage: ["launched-desktop-application"],
    caveat:
      "Instruments launches and records the Buzz application process instead of all macOS processes. JavaScriptCore stacks may not resolve to application JavaScript.",
  });
  const control = stopController();
  const runner = fileURLToPath(
    new URL("./profile-desktop-runner.mjs", import.meta.url),
  );
  const desktop = run(
    process.execPath,
    ["scripts/desktop-dev.mjs", "--runner", runner, ...args],
    { env: { ...process.env, BUZZ_PROFILE_TRACE: trace }, detached: false },
  );
  const desktopExit = new Promise((resolve) =>
    desktop.once("exit", (code, signal) =>
      resolve({ reason: "desktop", code: code ?? (signal ? 1 : 0) }),
    ),
  );
  console.log(
    "\nProfiling the launched Buzz desktop application. Press Ctrl-C to stop and save the profile.",
  );
  const outcome = await Promise.race([control.requested, desktopExit]);
  await stopChildren();
  await waitForTrace(trace);
  console.log(`\nProfile saved to ${trace}`);
  process.exitCode = forced ? 130 : outcome.code;
}

async function main() {
  const target = process.argv[2];
  const profileArgs = process.argv.slice(3);
  const network = target === "web" && profileArgs.includes("--network");
  const args = profileArgs.filter((argument) => argument !== "--network");
  if (target !== "web" && target !== "desktop") {
    console.error(
      "Usage: node scripts/profile-dev.mjs <web|desktop> [arguments]",
    );
    process.exitCode = 1;
    return;
  }
  if (process.platform !== "darwin") {
    console.error("Development profiling currently supports macOS only.");
    process.exitCode = 1;
    return;
  }
  const stamp = new Date()
    .toISOString()
    .replaceAll(":", "-")
    .replace(/\.\d{3}Z$/, "Z");
  const directory = `${root}.profiles/${stamp}-${target}`;
  await mkdir(directory, { recursive: true });
  if (target === "web")
    await profileWeb({ directory, profileArgs, args, network });
  else await profileDesktop({ directory, profileArgs, args });
}

if (
  process.argv[1] &&
  import.meta.url === new URL(process.argv[1], "file:").href
) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    await stopChildren();
    process.exitCode = 1;
  }
}
