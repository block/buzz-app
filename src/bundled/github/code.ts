// Code that GitHub links point at: a file at a ref, optionally some of its
// lines, or lines of a pull request's changes. Read with the person's `gh`
// sign-in where there is one; files are also read from the public API.
import { ReadError, transientStatus } from "../../features/relay/errors";
import { GitHubRateLimited } from "./data";
import { GhUnavailable, GitHubError, type GitHubCli } from "./gh";
import { readable } from "./object";

export type Lines = Readonly<{ start: number; end: number }>;
export type Side = "LEFT" | "RIGHT";
export type CodeLink =
  | Readonly<{
      kind: "blob";
      repository: string;
      /** The ref and path after `/blob/`: a ref can hold slashes too. */
      segments: readonly string[];
      lines?: Lines | undefined;
    }>
  | Readonly<{
      kind: "pull";
      repository: string;
      number: number;
      /** GitHub's anchor for a file: the SHA-256 of its path, in hex. */
      file: string;
      side: Side;
      lines: Lines;
    }>;

/** A review thread already on the shown file. */
export type Thread = Readonly<{
  line: number;
  startLine: number;
  side: Side;
  comments: readonly Readonly<{
    author: string;
    /** Only a GitHub avatar address; absent otherwise. */
    avatar?: string | undefined;
    body: string;
  }>[];
}>;
export type Code = Readonly<{
  ref: string;
  path: string;
  text: string;
  /** For a pull request link: what a review comment names, and the branch
   * the lines are read from. */
  pull?: Readonly<{ head: string; branch: string; threads: readonly Thread[] }>;
}>;

/** A GitHub avatar address, and nothing else, so a comment can only show
 * GitHub's own image. */
export const gitHubAvatar = (url: string | undefined) =>
  url && /^https:\/\/avatars\.githubusercontent\.com\//.test(url)
    ? url
    : undefined;

/** A ref that is a commit rather than a branch or tag. */
export const isCommit = (ref: string) => /^[0-9a-f]{7,40}$/i.test(ref);

/** Past this a file shows only a link to GitHub. */
export const MAX_BYTES = 256 * 1024;
/** GitHub numbers lines with 32-bit integers too. */
const MAX_LINE = 0x7fffffff;

const anchor = /^#L(\d+)(?:C\d+)?(?:-L(\d+)(?:C\d+)?)?$/;
const diffAnchor = /^#diff-([0-9a-f]{64})([LR])(\d+)(?:-([LR])(\d+))?$/;

function lineRange(start: string, end = start): Lines | undefined {
  const [a, b] = [Number(start), Number(end)];
  if (!(a >= 1 && b >= 1 && a <= MAX_LINE && b <= MAX_LINE)) return;
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

/** Exact host parsing, as for GitHub references: a lookalike domain or
 * credentials never become a card. */
export function parseCodeLink(value: string): CodeLink | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port ||
    url.username ||
    url.password
  )
    return;
  let parts: string[];
  try {
    parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return;
  }
  const [owner, repo, surface, ...rest] = parts;
  if (!owner || !repo || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo))
    return;
  const repository = `${owner}/${repo}`;
  if (surface === "blob" && rest.length >= 2) {
    if (!url.hash) return { kind: "blob", repository, segments: rest };
    const match = anchor.exec(url.hash);
    const lines = match && lineRange(match[1] as string, match[2]);
    return lines
      ? { kind: "blob", repository, segments: rest, lines }
      : undefined;
  }
  const [number, tab] = rest;
  const match = diffAnchor.exec(url.hash);
  if (
    surface !== "pull" ||
    rest.length !== 2 ||
    (tab !== "files" && tab !== "changes") ||
    !/^[1-9]\d*$/.test(number ?? "") ||
    Number(number) > MAX_LINE ||
    !match
  )
    return;
  const [, file, side, start, endSide, end] = match as unknown as string[];
  // A range across both sides shows where it starts.
  const lines = lineRange(start as string, endSide === side ? end : undefined);
  if (!lines) return;
  return {
    kind: "pull",
    repository,
    number: Number(number),
    file: file as string,
    side: side === "L" ? "LEFT" : "RIGHT",
    lines,
  };
}

/** Where a blob link's ref might end. Git refs can't nest (`a` and `a/b`
 * never both exist), so at most one split names a file. */
function candidates(segments: readonly string[]) {
  return segments
    .slice(0, Math.min(segments.length - 1, 4))
    .map((_, index) => ({
      ref: segments.slice(0, index + 1).join("/"),
      path: segments.slice(index + 1).join("/"),
    }));
}

type Blob = { byteSize: number; isBinary: boolean | null; text: string | null };
const blobFields = "... on Blob { byteSize isBinary text }";

function blobText(blob: Blob) {
  if (blob.byteSize > MAX_BYTES)
    throw new Error("This file is too large to show here.");
  if (blob.isBinary || blob.text === null)
    throw new Error("This is a binary file, so it can’t be shown here.");
  return blob.text;
}

async function readBlobSignedIn(
  gh: GitHubCli,
  link: Extract<CodeLink, { kind: "blob" }>,
  signal: AbortSignal,
): Promise<Code> {
  const [owner, name] = link.repository.split("/");
  const options = candidates(link.segments);
  const data = await gh<{ repository: Record<string, Blob | null> | null }>(
    `query($owner:String!,$name:String!,${options.map((_, i) => `$e${i}:String!`).join(",")}){repository(owner:$owner,name:$name){${options
      .map((_, i) => `f${i}:object(expression:$e${i}){${blobFields}}`)
      .join(" ")}}}`,
    Object.fromEntries([
      ["owner", owner],
      ["name", name],
      ...options.map(({ ref, path }, i) => [`e${i}`, `${ref}:${path}`]),
    ]),
    signal,
  );
  // A tree matches the Blob fragment as `{}`, so look for a Blob's field.
  const index = options.findIndex(
    (_, i) => typeof data.repository?.[`f${i}`]?.byteSize === "number",
  );
  const blob = data.repository?.[`f${index}`];
  if (!blob) throw new GitHubError("Not found", "NOT_FOUND");
  const { ref, path } = options[index] as { ref: string; path: string };
  return { ref, path, text: blobText(blob) };
}

async function readBlobPublic(
  link: Extract<CodeLink, { kind: "blob" }>,
  signal: AbortSignal,
): Promise<Code> {
  for (const { ref, path } of candidates(link.segments)) {
    const response = await fetch(
      `https://api.github.com/repos/${link.repository}/contents/${path
        .split("/")
        .map(encodeURIComponent)
        .join("/")}?ref=${encodeURIComponent(ref)}`,
      {
        signal,
        headers: { Accept: "application/vnd.github.raw+json" },
        credentials: "omit",
      },
    );
    if (response.status === 404) continue;
    if (response.status === 403 || response.status === 429)
      throw new GitHubRateLimited(
        Number(response.headers.get("x-ratelimit-reset")) * 1000 ||
          Date.now() + 60 * 60_000,
      );
    if (!response.ok) {
      const message = `GitHub couldn’t load this file (${response.status}).`;
      throw transientStatus(response.status)
        ? new ReadError("unavailable", message, response.status)
        : new Error(message);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
      ref,
      path,
      text: blobText({
        byteSize: bytes.byteLength,
        isBinary: bytes.includes(0),
        text: new TextDecoder().decode(bytes),
      }),
    };
  }
  throw new Error(
    "This is private or unavailable. Sign in to the gh CLI to see private repositories, or open it on GitHub.",
  );
}

async function sha256(text: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

type PullPage = {
  repository: {
    pullRequest: {
      headRefOid: string;
      baseRefOid: string;
      headRefName: string;
      baseRefName: string;
      files: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: { path: string }[];
      } | null;
    } | null;
  } | null;
};
type PullFile = {
  repository: {
    object: Blob | null;
    pullRequest: {
      reviewThreads: {
        nodes: {
          path: string;
          line: number | null;
          startLine: number | null;
          diffSide: Side;
          isOutdated: boolean;
          comments: {
            nodes: {
              author: { login: string; avatarUrl?: string } | null;
              bodyText: string;
            }[];
          };
        }[];
      };
    } | null;
  } | null;
};

/** GitHub lists at most 3,000 files of a pull request. */
const MAX_FILE_PAGES = 30;

async function readPull(
  gh: GitHubCli,
  link: Extract<CodeLink, { kind: "pull" }>,
  signal: AbortSignal,
): Promise<Code> {
  const [owner, name] = link.repository.split("/");
  const variables = { owner, name, number: link.number };
  let after: string | null = null;
  for (let page = 0; page < MAX_FILE_PAGES; page++) {
    const data: PullPage = await gh<PullPage>(
      `query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){
        headRefOid baseRefOid headRefName baseRefName files(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{path}}}}}`,
      { ...variables, after },
      signal,
    );
    const pull = data.repository?.pullRequest;
    if (!pull) throw new GitHubError("Not found", "NOT_FOUND");
    for (const { path } of pull.files?.nodes ?? []) {
      if ((await sha256(path)) !== link.file) continue;
      const ref = link.side === "RIGHT" ? pull.headRefOid : pull.baseRefOid;
      const file = await gh<PullFile>(
        `query($owner:String!,$name:String!,$number:Int!,$expression:String!){repository(owner:$owner,name:$name){
          object(expression:$expression){${blobFields}}
          pullRequest(number:$number){reviewThreads(last:100){nodes{path line startLine diffSide isOutdated
            comments(first:20){nodes{author{login avatarUrl} bodyText}}}}}}}`,
        { ...variables, expression: `${ref}:${path}` },
        signal,
      );
      const blob = file.repository?.object;
      if (!blob)
        throw new Error(
          link.side === "RIGHT"
            ? "This file was deleted in this pull request."
            : "This file is new in this pull request.",
        );
      return {
        ref,
        path,
        text: blobText(blob),
        pull: {
          head: pull.headRefOid,
          branch: link.side === "RIGHT" ? pull.headRefName : pull.baseRefName,
          threads: (file.repository?.pullRequest?.reviewThreads.nodes ?? [])
            .filter(
              (thread) =>
                thread.path === path && !thread.isOutdated && thread.line,
            )
            .map((thread) => ({
              line: thread.line as number,
              startLine: thread.startLine ?? (thread.line as number),
              side: thread.diffSide,
              comments: thread.comments.nodes.map((comment) => ({
                author: comment.author?.login ?? "ghost",
                avatar: gitHubAvatar(comment.author?.avatarUrl),
                body: comment.bodyText,
              })),
            })),
        },
      };
    }
    if (!pull.files?.pageInfo.hasNextPage) break;
    after = pull.files.pageInfo.endCursor;
  }
  throw new Error("This file is no longer part of this pull request.");
}

async function readCode(
  link: CodeLink,
  gh: GitHubCli | undefined,
  signal: AbortSignal,
): Promise<Code> {
  try {
    if (link.kind === "pull") {
      if (!gh) throw new GhUnavailable("No gh");
      return await readPull(gh, link, signal);
    }
    if (gh) return await readBlobSignedIn(gh, link, signal);
  } catch (error) {
    if (!(error instanceof GhUnavailable)) throw readable(error);
    if (link.kind === "pull")
      throw new Error(
        "Sign in to the gh CLI to see pull request changes here, or open it on GitHub.",
      );
  }
  return readBlobPublic(link, signal);
}

/** How many files the reader keeps, so scrolling past a link again does
 * not read it again. */
const HELD = 32;

export type CodeReader = Readonly<{
  read(link: CodeLink): Promise<Code>;
  /** Reads `link` again next time, as after commenting on it. */
  forget(link: CodeLink): void;
}>;

export function createCodeReader(gh: GitHubCli | undefined): CodeReader {
  const held = new Map<string, Promise<Code>>();
  const key = (link: CodeLink) =>
    link.kind === "blob"
      ? `${link.repository}/blob/${link.segments.join("/")}`
      : `${link.repository}/pull/${link.number}/${link.file}/${link.side}`;
  return {
    read(link) {
      const id = key(link);
      const found = held.get(id);
      if (found) return found;
      const read = readCode(link, gh, AbortSignal.timeout(30_000));
      held.set(id, read);
      // A failure is read again next time.
      read.catch(() => {
        if (held.get(id) === read) held.delete(id);
      });
      if (held.size > HELD) held.delete(held.keys().next().value as string);
      return read;
    },
    forget(link) {
      held.delete(key(link));
    },
  };
}
