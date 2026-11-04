// A channel follows a GitHub repository by holding a `buzz.github.hook`
// artifact: the repository and the webhook's secret, which only the relay can
// read. The relay posts each pull request to the channel as GitHub reports it.
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  ARTIFACT_KIND,
  deliver,
  readHead,
} from "../../features/agents/agent-config-artifacts";
import type { EventData } from "../../features/relay/events";
import type { RelaySession } from "../../features/relay/session";

export const HOOK_TYPE = "buzz.github.hook";
/** What GitHub's webhook form calls the events the relay reads. */
export const HOOK_EVENTS = [
  "Pull requests",
  "Pull request reviews",
  "Check suites",
  "Check runs",
  "Statuses",
] as const;

const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;

export type Hook = Readonly<{
  /** The artifact's `d`, which names the webhook's URL. */
  d: string;
  repo: string;
  /** The revision holding it, so a change builds on it. */
  head: string;
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
  return { d, repo, head: event.id };
}

/** Where GitHub posts the repository's webhook: the community's own host. */
export const webhookUrl = (origin: string, d: string) =>
  `https://${new URL(origin).host}/hooks/github/${d}`;

export function newSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/** Seals a secret from the person's key to the relay's, which the app's
 * native side holds; the browser has no such key. */
export const canSeal = isTauri;
export async function sealHookSecret(
  community: string,
  relay: string,
  secret: string,
) {
  const sealed = await invoke<string>("relay_seal_hook_secret", {
    community,
    relay,
    secret,
  });
  if (typeof sealed !== "string" || !sealed)
    throw new Error("The webhook secret could not be sealed.");
  return sealed;
}

export type Seal = (
  community: string,
  relay: string,
  secret: string,
) => Promise<string>;

type Revision = Readonly<{
  d: string;
  channel: string;
  op: "create" | "update" | "delete";
  prev?: string | undefined;
  repo: string;
  content?: { secret: string };
}>;

async function save(
  session: RelaySession,
  revision: Revision,
  signal: AbortSignal,
) {
  const writer = session.configArtifactWriter;
  if (!writer) throw new Error("This community connection can't save hooks.");
  const { d, channel, op, prev, repo, content } = revision;
  const event = await writer.sign(
    {
      kind: ARTIFACT_KIND,
      created_at: Math.floor(Date.now() / 1000),
      content:
        op === "delete" ? "" : JSON.stringify({ version: 1, repo, ...content }),
      tags: [
        ["ar", "1"],
        ["d", d],
        ["h", channel],
        ["type", HOOK_TYPE],
        ...(op === "delete" ? [] : [["title", repo]]),
        ["op", op],
        ...(prev ? [["prev", prev]] : []),
        ...(op === "delete" ? [] : [["repo", repo]]),
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

async function sealed(
  session: RelaySession,
  origin: string,
  seal: Seal,
  secret: string,
) {
  const relay = session.relayAuthor;
  if (!relay) throw new Error("This community's key is not known yet.");
  return { secret: await seal(origin, relay, secret) };
}

/** Follows `repo` in `channel`; the new hook's URL and the secret to give
 * GitHub, which is not kept anywhere else. */
export async function follow(
  session: RelaySession,
  origin: string,
  seal: Seal,
  channel: string,
  repo: string,
  signal = AbortSignal.timeout(20_000),
) {
  const secret = newSecret();
  const d = crypto.randomUUID();
  await save(
    session,
    {
      d,
      channel,
      op: "create",
      repo,
      content: await sealed(session, origin, seal, secret),
    },
    signal,
  );
  return { d, secret };
}

/** Gives `hook` a new secret, to give GitHub in place of the old. */
export async function regenerate(
  session: RelaySession,
  origin: string,
  seal: Seal,
  channel: string,
  hook: Hook,
  signal = AbortSignal.timeout(20_000),
) {
  const secret = newSecret();
  const content = await sealed(session, origin, seal, secret);
  await save(
    session,
    {
      d: hook.d,
      channel,
      op: "update",
      prev: await headOf(session, channel, hook, signal),
      repo: hook.repo,
      content,
    },
    signal,
  );
  return secret;
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
