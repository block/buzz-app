// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { mcpPrint } from "./mcp-print";

const listing = (server: Record<string, unknown>, extra = {}) => ({
  request: async () => ({
    extensions: [
      {
        configKey: "probe",
        enabled: true,
        extension: { type: "mcp", server, env_keys: ["A"], ...extra },
      },
    ],
  }),
});
const http = (value: string, url = "https://probe.test") => ({
  name: "probe",
  url,
  headers: [{ name: "Authorization", value }],
});
const print = (server: Record<string, unknown>, extra = {}) =>
  mcpPrint(listing(server, extra) as never, "agent", {}, false);

describe("mcpPrint", () => {
  it("changes with a native definition but not with a secret value", async () => {
    const base = await print(http("one"));
    expect(await print(http("two"))).toBe(base);
    expect(await print(http("one", "https://other.test"))).not.toBe(base);
    expect(await print(http("one"), { available_tools: ["read"] })).not.toBe(
      base,
    );
    expect(
      await print({ name: "probe", command: "probe", args: ["--a"] }),
    ).not.toBe(await print({ name: "probe", command: "probe", args: ["--b"] }));
  });
});
