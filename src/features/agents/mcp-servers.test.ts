// @vitest-environment jsdom
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { beforeEach, describe, expect, it } from "vitest";
import {
  approvalTemplate,
  approved,
  claudeServers,
  envName,
  launchList,
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
      transport: "stdio",
      command: "docs-mcp",
      args: ["--quiet"],
      env: ["TOKEN"],
    },
    {
      name: "off",
      enabled: false,
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
        env: { TOKEN: "${BUZZMCP_DOCS_TOKEN}" },
      },
    });
    expect(envName("my-server", "api.key")).toBe("BUZZMCP_MY_SERVER_API_KEY");
  });
});
