// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import type { AddedTool } from "../../buzz-mcp/session-tools";
import type { BuzzClient } from "../../buzz-mcp/client";
import { addAuthorRulesTool } from "./author-rules-tool";
import { DEFAULT_RULES, loadPolicy } from "./authors";
import { GitHubError, type GitHubCli } from "./gh";

afterEach(() => localStorage.clear());

function setup(gh?: GitHubCli) {
  const tools: AddedTool[] = [];
  addAuthorRulesTool({ addTool: (tool) => tools.push(tool) }, gh);
  const tool = tools[0] as AddedTool;
  return async (args: Record<string, unknown>) =>
    JSON.parse(
      String(await tool.call({} as BuzzClient, { channel: "c" }, args)),
    ) as unknown;
}

it("gives the saved rules, and saves rules that parse with what GitHub cannot resolve", async () => {
  const call = setup((async () => {
    throw new GitHubError("Could not resolve", "NOT_FOUND", {
      o0: { viewerIsAMember: true },
      o1: { viewerIsAMember: false },
    });
  }) as GitHubCli);
  expect(await call({})).toEqual({
    rules: DEFAULT_RULES,
    fallback: "allow",
    warnings: ["Comments from anyone no rule denies can wake agents"],
  });
  expect(
    await call({
      rules: `${DEFAULT_RULES}\nallow org:block\nallow org:aaif-goose`,
      fallback: "deny",
    }),
  ).toEqual({
    rules: `${DEFAULT_RULES}\nallow org:block\nallow org:aaif-goose`,
    fallback: "deny",
    warnings: [
      "org:aaif-goose: you are not a member of aaif-goose, so only its public members match",
    ],
  });
  expect(loadPolicy()).toMatchObject({
    text: `${DEFAULT_RULES}\nallow org:block\nallow org:aaif-goose`,
    fallback: "deny",
  });
});

it("keeps what it is not given, and refuses rules that do not parse", async () => {
  const call = setup();
  await call({ rules: "allow author:jbg", fallback: "deny" });
  expect(await call({ fallback: "allow" })).toMatchObject({
    rules: "allow author:jbg",
    fallback: "allow",
  });
  expect(await call({ rules: "allow author:eve" })).toMatchObject({
    fallback: "allow",
    warnings: [
      "Comments from anyone no rule denies can wake agents",
      "GitHub could not be asked about the names in these rules: gh is unavailable here",
    ],
  });
  await expect(call({ rules: "allow org:/x/" })).rejects.toThrow(
    "Line 1: org: takes an organization's exact name, not a /pattern/",
  );
  await expect(call({ fallback: "maybe" })).rejects.toThrow(
    "fallback must be allow or deny",
  );
  expect(loadPolicy().text).toBe("allow author:eve");
});
