// Agent end-to-end check: start a managed agent, mention it in a channel of a
// real relay, and fail unless it replies. The review rig runs it as its `agent`
// lane (`review-head <pr> --lanes=agent`); run it alone with
// `bin/node scripts/agent-e2e.mjs`.
//
// It stages the pinned goose-acp and a checksummed MinIO (the relay refuses to
// start without an S3 store that passes its Git conformance probe), builds the
// relay and its admin tool from the block/buzz revision this app already pins
// (as build-buzz-cli.mjs does for the CLI), starts a private PostgreSQL, Redis,
// MinIO and relay on free loopback ports in a temporary directory, and runs
// src/bundled/goose/agent-reply.live.test.ts against them. Nothing is installed
// or read outside that directory, no credential is used (the model is scripted
// and every key is generated), and everything it started is stopped on exit.
// The host needs the PostgreSQL server binaries and redis-server on disk.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buzzPin, cliBuildDir, cliTarget } from "./build-buzz-cli.mjs";

// The MinIO release block/buzz's own CI runs (.github/ci/minio/Dockerfile),
// with the checksums its release page publishes for each platform.
const MINIO_RELEASE = "RELEASE.2025-09-07T16-13-09Z";
export const MINIO_SHA256 = {
  "linux-amd64":
    "7c5bd8512c6e966455b1d198209358b2d191c77a83ab377c4073281065fb855f",
  "linux-arm64":
    "5c83cd2cf151717ba0243f73e1c7802ff36e272b67144bdd7f1f7d684fd6f03d",
  "darwin-amd64":
    "4759080aeef7385aaceaac1131c30aaeb99605921553967dc6d3ef4e16ac64f9",
  "darwin-arm64":
    "7c3b3039b76e55a1b80935848ed83998d5e8d317374f87851f46a019ff5c0aa4",
};

const root = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
const READY_MS = 60_000;

// Where a PostgreSQL server's own binaries live when they are not on PATH:
// distribution packages version their directory, Homebrew keeps them keg-only.
export function serverDirs(env, list = (dir) => readdirSync(dir)) {
  const versioned = (base) => {
    try {
      return list(base)
        .sort((a, b) => b.localeCompare(a, "en", { numeric: true }))
        .map((name) => join(base, name, "bin"));
    } catch {
      return [];
    }
  };
  return [
    ...(env.PATH ?? "").split(delimiter).filter(Boolean),
    ...versioned("/usr/lib/postgresql"),
    ...["/opt/homebrew/opt", "/usr/local/opt"].flatMap((base) =>
      versioned(base).filter((dir) => /postgresql@/.test(dir)),
    ),
  ];
}

export function findProgram(name, dirs, exists = existsSync) {
  for (const dir of dirs) {
    const path = join(dir, name);
    if (exists(path)) return path;
  }
  return undefined;
}

// What the relay needs, as block/buzz's own relay jobs start it, with loopback
// ports of ours and no S3, push or admin surface.
export function relayEnv({ postgres, redis, s3, port, health, metrics, key }) {
  return {
    DATABASE_URL: `postgres://buzz@127.0.0.1:${postgres}/buzz`,
    REDIS_URL: `redis://127.0.0.1:${redis}`,
    RELAY_URL: `ws://localhost:${port}`,
    BUZZ_BIND_ADDR: `127.0.0.1:${port}`,
    BUZZ_HEALTH_PORT: String(health),
    BUZZ_METRICS_PORT: String(metrics),
    BUZZ_RELAY_PRIVATE_KEY: key,
    BUZZ_REQUIRE_AUTH_TOKEN: "false",
    BUZZ_RECONCILE_CHANNELS: "true",
    BUZZ_PUSH_ENABLED: "false",
    BUZZ_S3_ENDPOINT: `http://127.0.0.1:${s3.port}`,
    BUZZ_S3_ACCESS_KEY: s3.user,
    BUZZ_S3_SECRET_KEY: s3.password,
    BUZZ_S3_BUCKET: s3.bucket,
    BUZZ_S3_REGION: "us-east-1",
    BUZZ_S3_ADDRESSING_STYLE: "path",
    RUST_LOG: "buzz_relay=info",
  };
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Waits for `url` to answer 200, or fails once the process behind it exits.
async function ready(url, exited, name, output = () => "") {
  const deadline = Date.now() + READY_MS;
  for (;;) {
    const code = exited();
    if (code !== undefined && code !== null)
      throw new Error(`${name} exited with ${code}:\n${output()}`);
    if ((await fetch(url).catch(() => undefined))?.ok) return;
    if (Date.now() > deadline)
      throw new Error(`${name} was not ready in ${READY_MS}ms:\n${output()}`);
    await sleep(500);
  }
}

function sh(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.slice(0, 2).join(" ")} → ${result.status ?? result.signal}\n${result.stdout}${result.stderr}`,
    );
  return result.stdout;
}

export const minioPlatform = (platform, arch) =>
  `${platform === "darwin" ? "darwin" : "linux"}-${arch === "arm64" ? "arm64" : "amd64"}`;

// Downloads MinIO once per checksum into the shared target directory.
async function stageMinio(target) {
  const platform = minioPlatform(process.platform, process.arch);
  const sha256 = MINIO_SHA256[platform];
  const binary = join(target, "minio-test", sha256, "minio");
  const digest = (path) =>
    createHash("sha256").update(readFileSync(path)).digest("hex");
  if (existsSync(binary) && digest(binary) === sha256) return binary;
  const url = `https://github.com/minio/minio/releases/download/${MINIO_RELEASE}/minio.${platform}.${MINIO_RELEASE}`;
  console.log(`agent-e2e: downloading minio ${MINIO_RELEASE} (${platform})`);
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok)
    throw new Error(`MinIO download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== sha256)
    throw new Error("MinIO SHA-256 mismatch");
  mkdirSync(join(target, "minio-test", sha256), { recursive: true });
  writeFileSync(`${binary}.new`, bytes);
  chmodSync(`${binary}.new`, 0o755);
  renameSync(`${binary}.new`, binary);
  return binary;
}

async function stage() {
  sh(process.execPath, [join(root, "scripts/build-goose-acp.mjs")], {
    cwd: root,
  });
  const { git, rev } = buzzPin(
    readFileSync(join(root, "src-tauri/Cargo.toml"), "utf8"),
  );
  const target = cliTarget(root);
  const prefix = join(target, "buzz-relay", rev);
  const build = spawnSync(
    "cargo",
    [
      "install",
      "--git",
      git,
      "--rev",
      rev,
      "--locked",
      "--root",
      prefix,
      "--target-dir",
      cliBuildDir(target, rev),
      "buzz-relay",
      "buzz-admin",
    ],
    { cwd: root, stdio: "inherit" },
  );
  if (build.status !== 0) throw new Error("Could not build the relay");
  return {
    minio: await stageMinio(target),
    goose: join(root, "src-tauri/resources/bin/goose-acp"),
    relay: join(prefix, "bin/buzz-relay"),
    admin: join(prefix, "bin/buzz-admin"),
    rev,
  };
}

async function main() {
  const dirs = serverDirs(process.env);
  const found = Object.fromEntries(
    ["initdb", "pg_ctl", "psql", "redis-server"].map((name) => [
      name,
      findProgram(name, dirs),
    ]),
  );
  const missing = Object.keys(found).filter((name) => !found[name]);
  if (missing.length)
    throw new Error(
      `Host is missing agent-e2e dependencies: ${missing.join(", ")}`,
    );

  const bins = await stage();
  const work = mkdtempSync(join(tmpdir(), "buzz-agent-e2e-"));
  const children = [];
  const cleanups = [];
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    for (const child of children) child.kill("SIGTERM");
    for (const cleanup of cleanups.reverse()) {
      try {
        cleanup();
      } catch (error) {
        console.error(`agent-e2e: cleanup: ${error.message}`);
      }
    }
    rmSync(work, { recursive: true, force: true });
  };
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => {
      stop();
      process.exit(130);
    });

  try {
    const [postgres, redis, s3port, s3ui, port, health, metrics] =
      await Promise.all(Array.from({ length: 7 }, freePort));
    const data = join(work, "postgres");
    const sockets = join(work, "sockets");
    mkdirSync(sockets);
    sh(found.initdb, ["-D", data, "-U", "buzz", "--auth=trust", "-E", "UTF8"]);
    sh(found.pg_ctl, [
      "-D",
      data,
      "-l",
      join(work, "postgres.log"),
      "-o",
      `-p ${postgres} -k ${sockets} -c listen_addresses=127.0.0.1 -c fsync=off`,
      "-w",
      "start",
    ]);
    cleanups.push(() =>
      sh(found.pg_ctl, ["-D", data, "-m", "immediate", "stop"]),
    );
    const psql = (...args) =>
      sh(found.psql, [
        "-h",
        "127.0.0.1",
        "-p",
        String(postgres),
        "-U",
        "buzz",
        "-v",
        "ON_ERROR_STOP=1",
        ...args,
      ]);
    psql("-d", "postgres", "-c", "CREATE DATABASE buzz");

    const redisChild = spawn(
      found["redis-server"],
      [
        "--port",
        String(redis),
        "--bind",
        "127.0.0.1",
        "--save",
        "",
        "--appendonly",
        "no",
        "--dir",
        work,
      ],
      { stdio: "ignore" },
    );
    children.push(redisChild);

    // A directory in MinIO's data folder is a bucket.
    const s3 = {
      port: s3port,
      user: randomBytes(8).toString("hex"),
      password: randomBytes(16).toString("hex"),
      bucket: "buzz-media",
    };
    mkdirSync(join(work, "s3", s3.bucket), { recursive: true });
    const minio = spawn(
      bins.minio,
      [
        "server",
        join(work, "s3"),
        "--address",
        `127.0.0.1:${s3port}`,
        "--console-address",
        `127.0.0.1:${s3ui}`,
      ],
      {
        env: {
          ...process.env,
          MINIO_ROOT_USER: s3.user,
          MINIO_ROOT_PASSWORD: s3.password,
        },
        stdio: "ignore",
      },
    );
    children.push(minio);
    await ready(
      `http://127.0.0.1:${s3port}/minio/health/live`,
      () => minio.exitCode,
      "MinIO",
    );

    const env = relayEnv({
      postgres,
      redis,
      s3,
      port,
      health,
      metrics,
      key: randomBytes(32).toString("hex"),
    });
    sh(bins.admin, ["migrate"], { env: { ...process.env, ...env } });
    // The relay binds each request to a community by its Host header and
    // refuses one it does not know, so the community must exist before it starts.
    psql(
      "-d",
      "buzz",
      "-c",
      `INSERT INTO communities (id, host) VALUES ('00000000-0000-4000-8000-00000000c0de', 'localhost:${port}')`,
    );
    const relay = spawn(bins.relay, [], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    for (const stream of [relay.stdout, relay.stderr])
      stream.on("data", (data) => {
        output = `${output}${data}`.slice(-20_000);
      });
    let exited;
    relay.on("exit", (code) => (exited = code));
    children.push(relay);
    await ready(
      `http://127.0.0.1:${port}/_readiness`,
      () => exited,
      "The relay",
      () => output,
    );
    console.log(
      `agent-e2e: relay (block/buzz ${bins.rev.slice(0, 12)}) ready on localhost:${port}`,
    );

    const test = spawnSync(
      join(root, "bin/pnpm"),
      [
        "exec",
        "vitest",
        "run",
        "src/bundled/goose/agent-reply.live.test.ts",
        "--reporter=default",
      ],
      {
        cwd: root,
        stdio: "inherit",
        env: {
          ...process.env,
          BUZZ_E2E_RELAY: `http://localhost:${port}`,
          GOOSE_ACP_BIN: bins.goose,
        },
      },
    );
    if (test.status !== 0) {
      console.error(`agent-e2e: relay output tail:\n${output.slice(-4000)}`);
      process.exitCode = test.status ?? 1;
    }
  } finally {
    stop();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
