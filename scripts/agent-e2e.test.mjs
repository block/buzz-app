import { describe, expect, it } from "vitest";
import {
  findProgram,
  MINIO_SHA256,
  minioPlatform,
  relayEnv,
  serverDirs,
} from "./agent-e2e.mjs";

describe("serverDirs", () => {
  it("looks on PATH, then in the newest packaged PostgreSQL", () => {
    const dirs = serverDirs({ PATH: "/a:/b" }, (base) =>
      base === "/usr/lib/postgresql" ? ["9.6", "16", "17"] : [],
    );
    expect(dirs).toEqual([
      "/a",
      "/b",
      "/usr/lib/postgresql/17/bin",
      "/usr/lib/postgresql/16/bin",
      "/usr/lib/postgresql/9.6/bin",
    ]);
  });

  it("keeps Homebrew's keg-only PostgreSQL and ignores other formulae", () => {
    const dirs = serverDirs({ PATH: "" }, (base) =>
      base === "/opt/homebrew/opt" ? ["redis", "postgresql@17"] : [],
    );
    expect(dirs).toEqual(["/opt/homebrew/opt/postgresql@17/bin"]);
  });

  it("survives a host without those directories", () => {
    expect(
      serverDirs({ PATH: "/a" }, () => {
        throw new Error("ENOENT");
      }),
    ).toEqual(["/a"]);
  });
});

it("finds a program in the first directory that has it", () => {
  const has = new Set(["/b/initdb", "/c/initdb"]);
  expect(findProgram("initdb", ["/a", "/b", "/c"], (p) => has.has(p))).toBe(
    "/b/initdb",
  );
  expect(findProgram("psql", ["/a"], () => false)).toBeUndefined();
});

it("points the relay at the private services and no real credential", () => {
  const env = relayEnv({
    postgres: 1,
    redis: 2,
    s3: { port: 3, user: "u", password: "p", bucket: "b" },
    port: 4,
    health: 5,
    metrics: 6,
    key: "k",
  });
  expect(env).toMatchObject({
    DATABASE_URL: "postgres://buzz@127.0.0.1:1/buzz",
    REDIS_URL: "redis://127.0.0.1:2",
    RELAY_URL: "ws://localhost:4",
    BUZZ_BIND_ADDR: "127.0.0.1:4",
    BUZZ_S3_ENDPOINT: "http://127.0.0.1:3",
    BUZZ_S3_BUCKET: "b",
  });
  expect(env.BUZZ_BIND_ADDR).toMatch(/^127\.0\.0\.1:/);
});

it("pins MinIO for each platform it can run on", () => {
  expect(minioPlatform("linux", "x64")).toBe("linux-amd64");
  expect(minioPlatform("darwin", "arm64")).toBe("darwin-arm64");
  for (const platform of ["linux", "darwin"])
    for (const arch of ["x64", "arm64"])
      expect(MINIO_SHA256[minioPlatform(platform, arch)]).toMatch(
        /^[0-9a-f]{64}$/,
      );
});
