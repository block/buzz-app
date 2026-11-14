import type { Agents } from "../../features/agents/service";
import type { RelaySession } from "../../features/relay/session";
import { ownSolo } from "../../features/solo/labels";
import { personalPull, savePersonalPull } from "./personal-pull";
import type { PullStates } from "./pull-states";
import { parseGitHubReference } from "./references";
import { hasSavedSoloPull, writeLink, type SoloPulls } from "./solo-pull";

export function addConversationPullTools(
  agents: Pick<Agents, "addTool" | "snapshot" | "relay">,
  states: PullStates,
  sharedFor: (session: RelaySession) => SoloPulls,
  canVerify = true,
) {
  for (const automatic of [false, true])
    agents.addTool({
      name: automatic ? "github_announce_pr" : "github_link_pr",
      description: automatic
        ? "Declare this conversation's own newly created PR with its exact head branch. Verifies signed-in GitHub authorship and branch, then automatically associates it for the owner on this device unless a saved link or manual unlink exists. Works in read-only channels too; does not publish a message or change the channel. Use after creating a PR, never for references or another author's work."
        : "Show a GitHub PR for this conversation in the owner's sidebar on this device, or unlink it. Replaces the personal association without publishing to the channel, including read-only channels. With shared true, changes the existing shared Solo link instead; requires the original creator's writable Solo.",
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The pull request's https://github.com/… URL",
          },
          ...(automatic
            ? {
                branch: {
                  type: "string",
                  description:
                    "The exact head branch of this conversation's new PR",
                },
              }
            : {
                unlink: { type: "boolean" },
                shared: {
                  type: "boolean",
                  description:
                    "Change the shared Solo artifact instead of the personal overlay",
                },
              }),
        },
        ...(automatic && { required: ["url", "branch"] }),
        additionalProperties: false,
      },
      async call(client, context, args) {
        const reference =
          typeof args.url === "string"
            ? parseGitHubReference(args.url)
            : undefined;
        const url =
          !automatic && args.unlink === true
            ? null
            : reference?.kind === "pull"
              ? reference.url
              : undefined;
        if (url === undefined)
          throw new Error("url must be a GitHub pull request URL");
        if (
          automatic &&
          (typeof args.branch !== "string" ||
            !args.branch ||
            args.branch.length > 255 ||
            /[\s\p{Cc}]/u.test(args.branch))
        )
          throw new Error("branch must be the PR's exact head branch");
        const connection = agents.relay(client.key);
        const captured = connection?.snapshot();
        const session =
          captured?.status === "ready" && !captured.cached
            ? captured.session
            : undefined;
        const channel = context.channel;
        if (!session || !channel)
          throw new Error("This tool needs this conversation's community");
        const allowed = () => {
          const now = connection?.snapshot();
          return (
            now?.status === "ready" &&
            !now.cached &&
            now.session === session &&
            agents
              .snapshot()
              .running.some(
                (agent) =>
                  agent.key === client.key &&
                  agent.pubkey === client.pubkey &&
                  agent.owner === session.viewer,
              ) &&
            session.channels.list().channels.some((item) => item.id === channel)
          );
        };
        if (!allowed())
          throw new Error(
            "This conversation is not available to this owner's agent",
          );
        const signal = client.signal
          ? AbortSignal.any([client.signal, AbortSignal.timeout(20_000)])
          : AbortSignal.timeout(20_000);
        if (!automatic && args.shared === true) {
          const writable = () => {
            const chat = session.channels
              .list()
              .channels.find((item) => item.id === channel);
            return (
              allowed() &&
              ownSolo(chat, session.viewer) &&
              !chat?.archived &&
              !chat?.readOnly
            );
          };
          if (!writable())
            throw new Error(
              "Shared links require the creator's writable Solo chat",
            );
          await writeLink(session, channel, url, signal, writable);
          sharedFor(session).linked(channel, url);
          return url
            ? `Shared Solo link saved: ${url}`
            : "Shared Solo link removed.";
        }
        if (automatic && url) {
          const existing = personalPull(session, channel);
          if (existing)
            return existing.source === "announcement" && existing.url === url
              ? `Already associated ${url} for this conversation on this device.`
              : "Kept the existing personal link or manual unlink. Use github_link_pr to replace it.";
          const chat = session.channels
            .list()
            .channels.find((item) => item.id === channel);
          if (
            chat?.channelType === "solo" &&
            (await hasSavedSoloPull(session, channel, signal))
          )
            return "Kept the saved Solo link or manual unlink. Use github_link_pr to replace your personal association.";
          signal.throwIfAborted();
          if (!allowed())
            throw new Error("This conversation's identity or access changed");
          if (!canVerify)
            throw new Error(
              "Automatic association needs the desktop gh CLI signed in",
            );
          const read = await states.read(url, { maxAge: 0, level: "details" });
          if (!allowed())
            throw new Error("This conversation's identity or access changed");
          if (
            read.error ||
            read.state === "failed" ||
            !read.state.details?.signedIn ||
            !read.state.details.checklist?.authored ||
            read.state.branch !== args.branch
          )
            throw new Error(
              "GitHub could not verify your PR's authorship and exact head branch",
            );
        }
        const saved = await savePersonalPull(session, channel, url, {
          automatic,
          signal,
          allowed,
        });
        return !saved
          ? "Kept the existing personal link or manual unlink. Use github_link_pr to replace it."
          : url
            ? `Showing ${url} for this conversation on this device only. No channel message or metadata was changed.`
            : "Removed this conversation's personal pull request. Automatic announcements will not restore it.";
      },
    });
}
