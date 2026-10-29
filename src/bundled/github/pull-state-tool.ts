// An agent's lookup of a pull request's state: what the owner's links and
// sidebar show, from the same store, with how old it is.
import type { AddedTool } from "../../buzz-mcp/session-tools";
import { PULL_REFRESH_MS, type PullStates } from "./pull-states";

export function addPullStateTool(
  agents: { addTool(tool: AddedTool): void },
  states: PullStates,
) {
  agents.addTool({
    name: "github_pr_state",
    description:
      "Reads a GitHub pull request's state as the owner's links show it: open, draft, merged or closed, its checks, failed check names and conflicts, and when it was read. It is at most a minute old unless fresh is true, or the last read failed: then last_read_failed says why and age_seconds how old it is. Checks and conflicts need the gh CLI signed in; without it only the state is known.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The pull request's https://github.com/… URL",
        },
        fresh: {
          type: "boolean",
          description: "Read it from GitHub now rather than within the minute",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
    async call(_client, _context, args) {
      if (typeof args.url !== "string")
        throw new Error("url must be a GitHub pull request URL");
      const { state, readAt, error } = await states.read(args.url, {
        maxAge: args.fresh === true ? 0 : PULL_REFRESH_MS,
      });
      if (state === "failed")
        throw new Error(
          `Could not read ${args.url}: ${error?.message ?? "GitHub did not answer"}`,
        );
      return JSON.stringify(
        {
          state: state.state,
          ...(state.head
            ? {
                checks: state.checks ?? "none",
                failed: state.failed,
                settled: state.settled,
                conflicts: state.conflicts,
                head: state.head,
              }
            : {}),
          read_at: new Date(readAt).toISOString(),
          age_seconds: Math.max(0, Math.round((Date.now() - readAt) / 1000)),
          source: state.head ? "gh" : "public",
          // The state above is the last one read; reading it again failed.
          ...(error ? { last_read_failed: error.message } : {}),
        },
        null,
        2,
      );
    },
  });
}
