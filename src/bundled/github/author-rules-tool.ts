// An agent's reading and saving of whose GitHub feedback wakes agents: the
// rules Settings edits, checked against GitHub the same way.
import type { AddedTool } from "../../buzz-mcp/session-tools";
import { loadPolicy, open, savePolicy, unresolved } from "./authors";
import type { GitHubCli } from "./gh";

export function addAuthorRulesTool(
  agents: { addTool(tool: AddedTool): void },
  gh: GitHubCli | undefined,
) {
  agents.addTool({
    name: "github_author_rules",
    description:
      "Reads or saves the owner's rules for whose GitHub comments and reviews wake agents watching pull requests; CI wakes them regardless. Without arguments it gives the saved rules. With rules or fallback it saves them at once, as Settings → GitHub comment authors does, and refuses rules that do not parse. Either way it lists warnings: organizations and users GitHub has no record of, organizations the owner is not a member of, whose private members never match, and rules that let anyone wake agents. One rule per line: allow or deny, then any of author:login, author:/pattern/, org:organization, body:/pattern/ and prefix:text, which runs to the end of the line. author:@me is the owner's GitHub account and a bot's login ends in [bot]. The first rule that matches decides; fallback decides feedback no rule matches.",
    inputSchema: {
      type: "object",
      properties: {
        rules: {
          type: "string",
          description: "The rules to save in place of the saved ones",
        },
        fallback: {
          type: "string",
          enum: ["allow", "deny"],
          description: "Whether feedback no rule matches wakes agents",
        },
      },
      additionalProperties: false,
    },
    async call(_client, _context, args) {
      const { rules, fallback } = args;
      if (rules !== undefined && typeof rules !== "string")
        throw new Error("rules must be text, one rule per line");
      if (fallback !== undefined && fallback !== "allow" && fallback !== "deny")
        throw new Error("fallback must be allow or deny");
      const saved = loadPolicy();
      const policy =
        rules === undefined && fallback === undefined
          ? saved
          : savePolicy(rules ?? saved.text, fallback ?? saved.fallback);
      return JSON.stringify(
        {
          rules: policy.text,
          fallback: policy.fallback,
          ...(policy.error ? { error: policy.error } : {}),
          warnings: [
            ...(open(policy)
              ? ["Comments from anyone no rule denies can wake agents"]
              : []),
            ...(await unresolved(policy, gh)),
          ],
        },
        null,
        2,
      );
    },
  });
}
