// The token use of an agent's Claude Code sessions, read from the transcripts
// Claude Code keeps on this computer. Claude Code owns the files; nothing here
// writes them. What each file said is kept while the app runs, so a later read
// opens only the files changed since.
import { readFile } from "../../buzz-mcp/app-client";
import { promptSections } from "../../features/agents/activity-transcript";
import type {
  SessionUsage,
  UsageObservation,
} from "../../features/agents/service";
import { withRevision } from "../../features/agents/session-usage";
import type { Host } from "../../features/host/service";
import type { Spawn } from "./claude";
import { workspaceProject } from "./transcript";

type Json = Record<string, unknown>;
/** Files read at once, by every agent's read together: the app refuses more
 * than 16 native reads at a time. */
const READERS = 8;
/** Minutes a changed-files listing looks back past the previous one, as
 * `find -mmin` counts whole minutes. */
const LIST_SLACK_MINUTES = 2;
/** Files one search names, under the app's 256 process arguments. */
const SEARCH_FILES = 200;
/** Searches run at once. */
const SEARCHES = 8;

const object = (value: unknown): Json | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : undefined;
const str = (value: unknown) => (typeof value === "string" ? value : "");
const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
/** A file's entries, and how many of its finished lines are not JSON. A
 * partial last line is still being written. */
function lines(file: string) {
  const all = file.split("\n");
  const entries: Json[] = [];
  let unreadable = 0;
  all.forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const entry = object(JSON.parse(line));
      if (entry) entries.push(entry);
    } catch {
      if (index < all.length - 1) unreadable += 1;
    }
  });
  return { entries, unreadable };
}
const promptText = (content: unknown) =>
  typeof content === "string"
    ? content
    : (Array.isArray(content) ? content : [])
        .map((block) => str(object(block)?.text))
        .join("\n");

/** Where the session started in Buzz and for which agent, from its first
 * prompt's context; undefined when Buzz did not start it. */
export function buzzStart(entries: readonly Json[]) {
  const first = entries.find(
    (entry) => entry.type === "user" && !entry.isMeta && !entry.isSidechain,
  );
  const context = promptSections(
    promptText(object(first?.message)?.content),
  ).find((section) => section.tag === "context")?.body;
  const field = (name: string) =>
    context?.match(new RegExp(`^${name}: (.*)$`, "m"))?.[1]?.trim();
  const channel = field("Channel");
  if (!channel) return undefined;
  const root = field("Session scope") === "thread" && field("Thread root");
  return {
    agent: field("Agent"),
    channelId: channel.match(/\(#([^)]+)\)$/)?.[1] ?? channel,
    ...(root ? { root } : {}),
  };
}

const COUNTS = {
  input: "input_tokens",
  output: "output_tokens",
  cacheRead: "cache_read_input_tokens",
  cacheWrite: "cache_creation_input_tokens",
} as const;

/** What one transcript file says, kept in place of its text. Each model
 * request once, keyed by its message and request ids when it has them:
 * Claude Code repeats a streamed response's usage on every content block's
 * line. */
type Digest = Readonly<{
  start?: ReturnType<typeof buzzStart>;
  title?: string;
  unreadable: number;
  /** Its earliest and latest entry times. */
  times?: Readonly<{ first: number; last: number }>;
  observations: readonly (readonly [string | undefined, UsageObservation])[];
  spawned: readonly string[];
}>;

function observations(entries: readonly Json[]) {
  const seen = new Map<string, UsageObservation>();
  const unkeyed = new Set<string>();
  for (const entry of entries) {
    const message = object(entry.message);
    const usage = object(message?.usage);
    const model = str(message?.model);
    const at = Date.parse(str(entry.timestamp));
    if (entry.type !== "assistant" || !usage || !model || !at) continue;
    if (model === "<synthetic>") continue;
    const counts = {
      ...Object.fromEntries(
        Object.entries(COUNTS).map(([name, field]) => [name, usage[field]]),
      ),
      cacheWrite1h: object(usage.cache_creation)?.ephemeral_1h_input_tokens,
    };
    const requestId = str(entry.requestId) || str(message?.id);
    const key = `${str(message?.id)}:${str(entry.requestId)}`;
    const observation: UsageObservation = {
      ...(requestId ? { requestId } : {}),
      at,
      model,
      tokens: Object.fromEntries(
        Object.entries(counts).flatMap(([name, raw]) => {
          const value = count(raw);
          return value === undefined ? [] : [[name, value]];
        }),
      ),
    };
    if (key === ":") {
      const own = `#${seen.size}`;
      unkeyed.add(own);
      seen.set(own, observation);
    } else seen.set(key, observation);
  }
  return [...seen].map(
    ([key, value]) => [unkeyed.has(key) ? undefined : key, value] as const,
  );
}

/** The transcript names, `agent-<id>`, of the subagents the entries record
 * spawning. */
const spawned = (entries: readonly Json[]) =>
  entries.flatMap((entry) => {
    const agentId = str(object(entry.toolUseResult)?.agentId);
    return /^[\w-]+$/.test(agentId) ? [`agent-${agentId}`] : [];
  });

function digest(file: string): Digest {
  const { entries, unreadable } = lines(file);
  let times: { first: number; last: number } | undefined;
  for (const entry of entries) {
    const at = Date.parse(str(entry.timestamp));
    if (!(at > 0)) continue;
    times ??= { first: at, last: at };
    times.first = Math.min(times.first, at);
    times.last = Math.max(times.last, at);
  }
  let title: string | undefined;
  for (const entry of entries)
    if (entry.type === "ai-title" && str(entry.aiTitle).trim())
      title = str(entry.aiTitle).trim();
  return {
    start: buzzStart(entries),
    ...(title ? { title } : {}),
    unreadable,
    ...(times && { times }),
    observations: observations(entries),
    spawned: spawned(entries),
  };
}

/** A session's usage from its file's digest and its subagents' by name
 * (undefined when one is gone), when Buzz started it for `agent`. */
function combine(
  id: string,
  main: Digest,
  subagents: ReadonlyMap<string, Digest | undefined>,
  agent: string,
  saved: boolean,
): Omit<SessionUsage, "revision"> | undefined {
  const { start } = main;
  if (!start || (start.agent ? start.agent !== agent : !saved))
    return undefined;
  const all = [main];
  const gaps: string[] = [];
  for (const subagent of subagents.values()) {
    if (subagent === undefined) gaps.push("A subagent’s transcript is gone");
    else all.push(subagent);
  }
  for (const name of new Set(all.flatMap((file) => file.spawned)))
    if (!subagents.has(name)) gaps.push("A subagent’s transcript is gone");
  const skipped = all.reduce((sum, file) => sum + file.unreadable, 0);
  if (skipped)
    gaps.push(
      `${skipped} transcript line${skipped === 1 ? "" : "s"} unreadable`,
    );
  const times = all.flatMap((file) => file.times ?? []);
  if (!times.length) return undefined;
  const seen = new Map<string, UsageObservation>();
  for (const file of all)
    for (const [key, observation] of file.observations)
      seen.set(key ?? `${seen.size}`, observation);
  return {
    id,
    channelId: start.channelId,
    ...(start.root ? { root: start.root } : {}),
    ...(main.title ? { title: main.title } : {}),
    startedAt: Math.min(...times.map((time) => time.first)),
    lastAt: Math.max(...times.map((time) => time.last)),
    gaps,
    observations: [...seen.values()],
  };
}

/** A session file's usage, with its subagents' files by name (undefined when
 * one is gone), when Buzz started it for `agent`. A subagent the session
 * recorded spawning without a file is gone too. A saved session also counts
 * when its prompt does not name an agent, as prompts did before agents were
 * named. */
export function sessionUsage(
  id: string,
  file: string,
  subagents: ReadonlyMap<string, string | undefined>,
  agent: string,
  saved: boolean,
): Omit<SessionUsage, "revision"> | undefined {
  return combine(
    id,
    digest(file),
    new Map(
      [...subagents].map(([name, text]) => [
        name,
        text === undefined ? undefined : digest(text),
      ]),
    ),
    agent,
    saved,
  );
}

export type UsageHost = Readonly<{
  spawn: Spawn;
  /** The app's own file read; without it, files pass through `base64`. */
  readFile?: Host["readFile"];
}>;

/** One Claude Code project directory as the app's earlier reads left it. */
type Project = {
  /** When the latest listing of its files started; a file changed after it
   * is read again. */
  listedAt: number;
  /** The listing under way, which reads made meanwhile share. */
  listing?: Promise<void> | undefined;
  /** Every file the latest listing found. */
  paths: ReadonlySet<string>;
  /** Each session's subagent transcripts, by path. */
  subagents: ReadonlyMap<string, readonly string[]>;
  /** The agent each session file's first prompt names. */
  owners: Map<string, string>;
  /** Session files searched that name none, searched again once changed. */
  unowned: Set<string>;
  /** Each file's digest by path, undefined when it is gone. */
  digests: Map<string, Promise<Digest | undefined>>;
};
/** Per host, so a plugin that reloads starts over. */
const cache = new WeakMap<Spawn, Map<string, Project>>();

/** The lines a process prints, failing on any exit but those in `ok`. */
async function output(
  spawn: Spawn,
  id: string,
  project: string,
  args: readonly string[],
  ok: readonly number[],
) {
  let text = "";
  let errors = "";
  const process = await spawn(id, {
    args: [...args],
    cwd: `~/.claude/projects/${project}`,
    onStdout: (data) => {
      text += data;
    },
    onStderr: (data) => {
      errors += data;
    },
  });
  const code = await process.exited;
  if (code === null || !ok.includes(code))
    throw new Error(
      `Couldn’t read the Claude Code history: ${errors.trim() || `exit ${code}`}`,
    );
  return text
    .split("\n")
    .map((line) => line.trim().replace(/^\.\//, ""))
    .filter(Boolean);
}

/** The project's `.jsonl` files, subagents' included, changed in the last
 * `minutes` when given. */
const list = (spawn: Spawn, project: string, minutes?: number) =>
  output(
    spawn,
    "list",
    project,
    minutes === undefined ? [] : ["-mmin", `-${minutes}`],
    [0],
  );

/** Records the agent each of the session files at `paths` names first, one
 * search for every agent: the search stops at a file's first prompt. */
async function search(
  spawn: Spawn,
  project: string,
  state: Project,
  paths: readonly string[],
) {
  // No match exits 1.
  const found = await output(spawn, "owners", project, paths, [0, 1]);
  const owners = new Map<string, string>();
  for (const line of found) {
    const match = /^([^/]+\.jsonl):Agent: ([0-9a-f]{64})$/.exec(line);
    if (match?.[1] && match[2]) owners.set(match[1], match[2]);
  }
  for (const [name, owner] of owners) {
    state.owners.set(name, owner);
    state.unowned.delete(name);
  }
  return owners;
}

/** Brings `state` up to date with the project's files: the digests of files
 * changed, gone or new since its last listing are dropped, and new session
 * files are searched for the agent they belong to. */
async function refresh(spawn: Spawn, project: string, state: Project) {
  const first = !state.listedAt;
  const startedAt = Date.now();
  const [all, changed] = await Promise.all([
    list(spawn, project),
    first
      ? []
      : list(
          spawn,
          project,
          // A clock set back must not make the count invalid.
          Math.ceil(Math.max(0, startedAt - state.listedAt) / 60_000) +
            LIST_SLACK_MINUTES,
        ),
  ]);
  const paths = new Set(all);
  const recent = new Set(changed);
  for (const path of [...recent, ...state.paths])
    if (recent.has(path) || !paths.has(path)) state.digests.delete(path);
  const subagents = new Map<string, string[]>();
  for (const path of paths) {
    if (!state.paths.has(path)) state.digests.delete(path);
    const match = /^([\w-]+)\/subagents\/[^/]+\.jsonl$/.exec(path);
    if (match?.[1])
      subagents.set(match[1], [...(subagents.get(match[1]) ?? []), path]);
  }
  const sessions = [...paths].filter((path) => /^[^/]+\.jsonl$/.test(path));
  for (const name of [...state.owners.keys(), ...state.unowned])
    if (!paths.has(name)) {
      state.owners.delete(name);
      state.unowned.delete(name);
    }
  // A file still being written may not have its first prompt yet.
  const unsearched = sessions.filter(
    (name) =>
      !state.owners.has(name) && (!state.unowned.has(name) || recent.has(name)),
  );
  // In parallel: one search takes a core, and the first reads every file.
  const size = Math.max(
    1,
    Math.min(SEARCH_FILES, Math.ceil(unsearched.length / SEARCHES)),
  );
  const batches = Array.from(
    { length: Math.ceil(unsearched.length / size) },
    (_, index) => unsearched.slice(index * size, (index + 1) * size),
  );
  const searcher = async () => {
    for (let batch = batches.shift(); batch; batch = batches.shift()) {
      const owners = await search(spawn, project, state, batch);
      for (const name of batch) if (!owners.has(name)) state.unowned.add(name);
    }
  };
  await Promise.all(Array.from({ length: SEARCHES }, searcher));
  state.paths = paths;
  state.subagents = subagents;
  state.listedAt = startedAt;
}

/** Runs `work` once a reader is free. */
let reading = 0;
const waiting: (() => void)[] = [];
async function reader<T>(work: () => Promise<T>) {
  if (reading >= READERS)
    await new Promise<void>((resolve) => waiting.push(resolve));
  else reading += 1;
  try {
    return await work();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else reading -= 1;
  }
}

/** The agent's Buzz sessions in its workspace's Claude Code history, active
 * since `since`. `saved` are the session ids this app saved for it. */
export async function readUsage(
  host: UsageHost,
  workspace: string,
  agent: string,
  saved: readonly string[],
  since: number,
  signal: AbortSignal,
): Promise<SessionUsage[]> {
  const { spawn } = host;
  const project = await workspaceProject(spawn, workspace, signal);
  if (!project) return [];
  const projects = cache.get(spawn) ?? new Map<string, Project>();
  cache.set(spawn, projects);
  let state = projects.get(project);
  if (!state) {
    state = {
      listedAt: 0,
      paths: new Set(),
      subagents: new Map(),
      owners: new Map(),
      unowned: new Set(),
      digests: new Map(),
    };
    projects.set(project, state);
  }
  const current = state;
  // Agents read together share one listing; files changed while it ran are
  // listed next time.
  current.listing ??= refresh(spawn, project, current).finally(() => {
    current.listing = undefined;
  });
  await current.listing;
  signal.throwIfAborted();
  const named = [...current.owners]
    .filter(([, owner]) => owner === agent)
    .map(([name]) => name);
  const savedNames = new Set(
    saved.filter((id) => /^[\w-]+$/.test(id)).map((id) => `${id}.jsonl`),
  );
  const read = (path: string) => {
    let pending = current.digests.get(path);
    if (pending) return pending;
    pending = reader(async () => {
      try {
        return digest(
          new TextDecoder().decode(
            host.readFile
              ? await host.readFile(`~/.claude/projects/${project}/${path}`)
              : // Project names start with `-`; GNU base64 would read one as
                // options.
                await readFile(
                  spawn,
                  "~/.claude/projects",
                  `./${project}/${path}`,
                ),
          ),
        );
      } catch (error) {
        if (/no such file/i.test(error instanceof Error ? error.message : ""))
          return undefined;
        throw error;
      }
    });
    current.digests.set(path, pending);
    // A failed read is tried again next time.
    pending.catch(() => {
      if (current.digests.get(path) === pending) current.digests.delete(path);
    });
    return pending;
  };
  const sessions = await Promise.all(
    [...new Set([...savedNames, ...named])].map(async (name) => {
      const main = await read(name);
      signal.throwIfAborted();
      if (!main) return undefined;
      const id = name.slice(0, -".jsonl".length);
      const subagents = new Map(
        await Promise.all(
          [...(current.subagents.get(id) ?? [])].map(
            async (path) =>
              [
                path.slice(path.lastIndexOf("/") + 1, -".jsonl".length),
                await read(path),
              ] as const,
          ),
        ),
      );
      signal.throwIfAborted();
      const session = combine(id, main, subagents, agent, savedNames.has(name));
      return session && session.lastAt >= since
        ? withRevision(session)
        : undefined;
    }),
  );
  return sessions
    .filter((session) => session !== undefined)
    .sort((a, b) => b.lastAt - a.lastAt);
}
