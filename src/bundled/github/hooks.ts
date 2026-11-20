// A channel follows a GitHub repository by holding a `github.hook`
// artifact that names its author as the publisher, whose own Buzz reads
// GitHub and posts its pull requests (publisher.ts).
import {
  ARTIFACT_KIND,
  deliver,
  readHead,
} from "../../features/agents/agent-config-artifacts";
import type { EventData } from "../../features/relay/events";
import type { RelaySession } from "../../features/relay/session";

export const HOOK_TYPE = "github.hook";

const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;
const PUBKEY = /^[0-9a-f]{64}$/;

export type Hook = Readonly<{
  d: string;
  repo: string;
  /** The revision holding it, so a change builds on it. */
  head: string;
  author: string;
  /** When the head was written, in Unix seconds. */
  createdAt: number;
  /** Who posts its pull requests from their own Buzz: only ever the hook's
   * own author. */
  publisher: string;
}>;

const tag = (event: EventData, name: string) =>
  event.tags.find((entry) => entry[0] === name)?.[1];

/** `owner/repo`, or a github.com link to one, as the lowercase name a hook
 * holds; undefined for anything else. */
export function repositoryOf(input: string) {
  const name = input
    .trim()
    .replace(/^https:\/\/github\.com\//i, "")
    .replace(/(\.git)?\/?$/, "");
  return REPOSITORY.test(name) ? name.toLowerCase() : undefined;
}

export function parseHook(event: EventData): Hook | undefined {
  const d = tag(event, "d");
  const repo = tag(event, "repo");
  if (
    event.kind !== ARTIFACT_KIND ||
    tag(event, "type") !== HOOK_TYPE ||
    !d ||
    !repo ||
    repositoryOf(repo) !== repo
  )
    return undefined;
  const publisher = tag(event, "publisher");
  if (!publisher || !PUBKEY.test(publisher) || publisher !== event.pubkey)
    return undefined;
  return {
    d,
    repo,
    head: event.id,
    author: event.pubkey,
    createdAt: event.created_at,
    publisher,
  };
}

type Revision = Readonly<{
  d: string;
  channel: string;
  op: "create" | "update" | "delete";
  prev?: string | undefined;
  repo: string;
  publisher?: string | undefined;
}>;

async function save(
  session: RelaySession,
  revision: Revision,
  signal: AbortSignal,
) {
  const writer = session.configArtifactWriter;
  if (!writer) throw new Error("This community connection can't save hooks.");
  const { d, channel, op, prev, repo, publisher } = revision;
  const event = await writer.sign(
    {
      kind: ARTIFACT_KIND,
      created_at: Math.floor(Date.now() / 1000),
      content: op === "delete" ? "" : JSON.stringify({ version: 1, repo }),
      tags: [
        ["ar", "1"],
        ["d", d],
        ["h", channel],
        ["type", HOOK_TYPE],
        ...(op === "delete" ? [] : [["title", repo]]),
        ["op", op],
        ...(prev ? [["prev", prev]] : []),
        ...(op === "delete" ? [] : [["repo", repo]]),
        ...(op !== "delete" && publisher ? [["publisher", publisher]] : []),
      ],
    },
    signal,
  );
  const delivery = await deliver(writer, event, signal);
  if (delivery.status === "refused")
    throw new Error(`The community refused it: ${delivery.message}`);
  if (delivery.status === "uncertain")
    throw new Error(`It may not have been saved: ${delivery.message}`);
}

/** Follows `repo` in `channel` with the person's own Buzz as its publisher,
 * which keeps its cards only while it is open. */
export async function follow(
  session: RelaySession,
  channel: string,
  repo: string,
  signal = AbortSignal.timeout(20_000),
) {
  const publisher = session.viewer;
  if (!publisher) throw new Error("Your key is not known yet.");
  const d = crypto.randomUUID();
  await save(session, { d, channel, op: "create", repo, publisher }, signal);
  return d;
}

export async function unfollow(
  session: RelaySession,
  channel: string,
  hook: Hook,
  signal = AbortSignal.timeout(20_000),
) {
  await save(
    session,
    {
      d: hook.d,
      channel,
      op: "delete",
      prev: await headOf(session, channel, hook, signal),
      repo: hook.repo,
    },
    signal,
  );
}

/** The hook's latest revision, which the change builds on. */
async function headOf(
  session: RelaySession,
  channel: string,
  hook: Hook,
  signal: AbortSignal,
) {
  const read = session.snapshotRead;
  const head = read && (await readHead(read, channel, hook.d, signal));
  if (!head) throw new Error("The hook could not be read. Try again.");
  return head.id;
}
