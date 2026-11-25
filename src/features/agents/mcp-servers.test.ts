// @vitest-environment jsdom
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { beforeEach, describe, expect, it } from "vitest";
import {
  approvalTemplate,
  approved,
  claudeServers,
  envName,
  isServer,
  launchList,
  nextSeq,
  newSlot,
  type McpList,
  startList,
} from "./mcp-servers";

const owner = generateSecretKey();
const OWNER = getPublicKey(owner);
const AGENT = "a".repeat(64);
const list: McpList = {
  servers: [
    {
      name: "docs",
      enabled: true,
      slot: "00000000000000aa",
      transport: "stdio",
      command: "docs-mcp",
      args: ["--quiet"],
      env: ["TOKEN"],
    },
    {
      name: "off",
      enabled: false,
      slot: "00000000000000bb",
      transport: "http",
      url: "https://example.com/mcp",
      headers: [],
    },
  ],
  disabledInherited: ["github"],
};
const sign = (seq: number, key = owner, body = list) =>
  finalizeEvent(approvalTemplate(AGENT, seq, body), key);

beforeEach(() => localStorage.clear());

describe("approved", () => {
  it("accepts only the owner's signature for this agent", () => {
    expect(approved(sign(1), OWNER, AGENT)).toMatchObject({ ok: true, list });
    expect(approved(sign(1, generateSecretKey()), OWNER, AGENT).ok).toBe(false);
    expect(approved({ ...sign(1), content: "{}" }, OWNER, AGENT).ok).toBe(
      false,
    );
    expect(approved(sign(1), OWNER, "b".repeat(64)).ok).toBe(false);
  });

  it("refuses a list older than one this device used", () => {
    expect(approved(sign(2), OWNER, AGENT).ok).toBe(true);
    expect(approved(sign(1), OWNER, AGENT)).toEqual({
      ok: false,
      reason: "These MCP servers are older than ones this device has used",
    });
  });

  it("breaks an equal-seq tie by the lower id", () => {
    const a = sign(3);
    const b = sign(3, owner, { ...list, disabledInherited: [] });
    const [low, high] = a.id < b.id ? [a, b] : [b, a];
    expect(approved(high, OWNER, AGENT).ok).toBe(true);
    expect(approved(low, OWNER, AGENT).ok).toBe(true);
    expect(approved(high, OWNER, AGENT).ok).toBe(false);
    expect(approved(low, OWNER, AGENT).ok).toBe(true);
  });

  it("keeps using the list it accepted when the settings leave it out", () => {
    const kept = sign(1);
    expect(approved(kept, OWNER, AGENT).ok).toBe(true);
    expect(approved(undefined, OWNER, AGENT)).toMatchObject({
      ok: true,
      list,
      id: kept.id,
      kept: true,
    });
    // A list that is there but invalid never falls back.
    expect(approved({ ...kept, sig: "00" }, OWNER, AGENT).ok).toBe(false);
    // One it can't recover fails closed, rather than reading as none.
    const record = JSON.parse(
      localStorage.getItem("buzz.agents.mcp-approvals.v1") ?? "{}",
    );
    record[AGENT].event.content = "{}";
    localStorage.setItem(
      "buzz.agents.mcp-approvals.v1",
      JSON.stringify(record),
    );
    expect(approved(undefined, OWNER, AGENT).ok).toBe(false);
  });

  it("never throws on a malformed list", () => {
    for (const bad of [null, 1, "x", { sig: "s" }, { sig: "s", tags: 1 }])
      expect(approved(bad, OWNER, AGENT).ok).toBe(false);
  });

  it("counts on only a verified head", () => {
    expect(nextSeq(AGENT, OWNER, sign(4))).toBe(5);
    expect(nextSeq(AGENT, OWNER, sign(2 ** 52, generateSecretKey()))).toBe(1);
    expect(() =>
      nextSeq(AGENT, OWNER, sign(Number.MAX_SAFE_INTEGER)),
    ).toThrow();
  });

  it("takes no list as none", () => {
    expect(startList({}, { pubkey: AGENT, owner: OWNER })).toEqual({
      servers: [],
      disabledInherited: [],
    });
    expect(() =>
      startList(
        { mcpServers: sign(1, generateSecretKey()) },
        { pubkey: AGENT, owner: OWNER },
      ),
    ).toThrow("MCP servers not approved");
  });
});

describe("launch", () => {
  it("leaves out turned-off servers and names the harness already has", () => {
    expect(launchList(list, ["docs", "github"])).toEqual({
      servers: [],
      disabledInherited: ["github"],
    });
    expect(launchList(list).servers.map((s) => s.name)).toEqual(["docs"]);
    expect(launchList(list).disabledInherited).toEqual([]);
  });

  it("gives Claude Code only references to values", () => {
    expect(claudeServers(launchList(list))).toEqual({
      docs: {
        type: "stdio",
        command: "docs-mcp",
        args: ["--quiet"],
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude expands it
        env: { TOKEN: "${BUZZMCP_00000000000000AA_544F4B454E}" },
      },
    });
  });

  it("keeps every server's and name's values apart", () => {
    const slot = "00000000000000aa";
    expect(envName(slot, "a_b")).not.toBe(envName(slot, "a-b"));
    expect(envName(slot, "token")).not.toBe(envName(slot, "TOKEN"));
    expect(envName(slot, "x")).not.toBe(envName("00000000000000bb", "x"));
    expect(envName(slot, "a".repeat(48))).toMatch(/^BUZZMCP_[0-9A-F_]{1,120}$/);
    expect(newSlot([])).toMatch(/^[0-9a-f]{16}$/);
  });

  it("takes from the form only what a launch accepts", () => {
    const [docs] = list.servers;
    expect(isServer(docs)).toBe(true);
    expect(isServer({ ...list.servers[1], url: "https://" })).toBe(false);
    expect(isServer({ ...docs, command: "  " })).toBe(false);
    expect(isServer({ ...docs, env: ["A", "A"] })).toBe(false);
    expect(isServer({ ...docs, slot: "x" })).toBe(false);
  });
});
