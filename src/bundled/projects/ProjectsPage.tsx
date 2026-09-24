import { useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { PageProps } from "../../features/pages/service";
import type { PageNavigation } from "../../features/navigation/service";
import type {
  Navigation,
  OpenFailure,
} from "../../features/navigation/controller";
import type { NavigationScope } from "../../features/navigation/targets";
import {
  buzzLinkTarget,
  isBuzzLink,
} from "../../features/navigation/buzz-links";
import { useRelayConnection, useChannelList } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import {
  EntityFailure,
  entityFailure,
  value,
  values,
  type Entity,
  type EntityDetail,
} from "../../features/projects/destinations";
import {
  entityHref,
  entityDtag,
  entityTarget,
  entityTabs,
  parseEntityRoute,
  type EntityRoute,
} from "../../features/projects/routes";
import type { GitSnapshot } from "../../features/projects/git";
import { formatPublicKey } from "../../shared/identity/public-key";
import { FullPageSurface } from "../../shared/design-system/ui/FullPageSurface";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import {
  CopyIcon,
  FileTextIcon,
  GitBranchIcon,
} from "../../shared/design-system/icons";
import "./projects.css";

type Open = Navigation["open"];
const labels = {
  overview: "Overview",
  files: "Files",
  commits: "Commits",
  prs: "Pull requests",
  issues: "Issues",
  contributors: "Contributors",
  channels: "Channels",
};
const tabs = ["overview", ...entityTabs].map((value) => ({
  value,
  label: labels[value as keyof typeof labels],
}));
type Loaded = {
  detail?: EntityDetail;
  directory?: Entity[];
  git?: GitSnapshot;
  gitChannel?: string;
  gitError?: OpenFailure;
};

export function ProjectsPage({
  relay,
  navigation,
  open,
}: PageProps & { relay: RelayData; open: Open }) {
  const connection = useRelayConnection(relay);
  const request = useMemo(
    () => navigation?.forSession(relay, connection),
    [navigation, relay, connection],
  );
  const target = request?.target;
  const scope = target?.kind === "page" ? target.scope : undefined;
  useEffect(() => {
    if (!request || request.signal.aborted) return;
    if (
      !scope ||
      connection.status === "error" ||
      connection.status === "disconnected"
    )
      request.complete({ status: "failed", reason: "unavailable" });
  }, [request, connection, scope]);
  return (
    <FullPageSurface aria-label="Projects">
      <div className="projects-page text-body">
        {connection.status === "ready" && request && scope ? (
          <Destination
            key={`${connection.scope}:${connection.generation}`}
            session={connection.session}
            request={request}
            open={open}
            scope={scope}
          />
        ) : (
          <>
            <h1 className="text-title">Projects</h1>
            <p role="status">
              {connection.status === "connecting"
                ? "Connecting to your community..."
                : "Select a community to browse projects."}
            </p>
          </>
        )}
      </div>
    </FullPageSurface>
  );
}

function Destination({
  session,
  request,
  open,
  scope,
}: {
  session: RelaySession;
  request: PageNavigation;
  open: Open;
  scope: NavigationScope;
}) {
  const target = request.target;
  const route = useMemo(
    () =>
      target.kind === "page" && target.route
        ? parseEntityRoute(target.route.params)
        : null,
    [target],
  );
  const [selection, setSelection] = useState<{
    target: typeof target;
    path: string | undefined;
  }>();
  const path = selection?.target === target ? selection.path : undefined;
  const setPath = (path: string | undefined) => setSelection({ target, path });
  const [refresh, setRefresh] = useState(0);
  const owner = useMemo(
    () => ({ request, route, path, refresh }),
    [request, route, path, refresh],
  );
  const [state, setState] = useState<{
    owner: typeof owner;
    data?: Loaded;
    error?: OpenFailure;
  }>();
  const heading = useRef<HTMLHeadingElement>(null);
  useChannelList(session.channels);
  const current = state?.owner === owner ? state : undefined;
  const stored = current?.data;
  const revoked =
    !!stored?.git &&
    !!stored.gitChannel &&
    !session.channels.get?.(stored.gitChannel);
  const data =
    revoked && stored
      ? { ...stored, git: undefined, gitError: "denied" as const }
      : stored;
  const gitRequired =
    route &&
    "tab" in route &&
    ["files", "commits", "contributors"].includes(route.tab ?? "");
  useEffect(() => {
    if (revoked)
      setState((previous) => {
        if (previous?.owner !== owner || !previous.data) return previous;
        const { git: _git, ...metadata } = previous.data;
        return { owner, data: { ...metadata, gitError: "denied" } };
      });
  }, [revoked, owner]);
  useEffect(() => {
    if (request.signal.aborted) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, request.signal]);
    async function load(): Promise<Loaded> {
      if (target.kind !== "page" || (target.route && !route))
        throw new EntityFailure("invalid-target");
      if (!route) return { directory: await session.projects.list(signal) };
      const detail = await session.projects.load(route, signal);
      const tab = "tab" in route ? route.tab : undefined;
      if (
        "id" in route ||
        tab === "prs" ||
        tab === "issues" ||
        tab === "channels" ||
        (route.type === "project" && !tab)
      )
        return { detail };
      const repository =
        detail.repositories.find((repo) => repo.dtag === route.dtag) ??
        detail.repositories[0];
      if (!repository) {
        if (detail.unavailableRepositories.length)
          throw new EntityFailure("unavailable");
        return { detail };
      }
      try {
        if (!session.projectGit) throw new EntityFailure("unavailable");
        const gitChannel = value(repository.event, "buzz-channel");
        if (gitChannel) {
          await session.channels.resolve?.([gitChannel], { signal });
          if (!session.channels.get?.(gitChannel))
            throw new EntityFailure("denied");
        }
        const git = await session.projectGit.read(
          {
            owner: repository.owner,
            dtag: repository.dtag,
            ...(route.type === "repo" && route.commit
              ? { commit: route.commit }
              : {}),
            ...(path ? { path } : {}),
          },
          signal,
        );
        return { detail, git, ...(gitChannel ? { gitChannel } : {}) };
      } catch (error) {
        signal.throwIfAborted();
        if (tab) throw error;
        return { detail, gitError: entityFailure(error) };
      }
    }
    void load().then(
      (data) => {
        if (!signal.aborted) setState({ owner, data });
      },
      (error) => {
        if (!signal.aborted) setState({ owner, error: entityFailure(error) });
      },
    );
    return () => controller.abort();
  }, [owner, request, route, session, target, path]);
  useEffect(() => {
    if (current?.error || (gitRequired && data?.gitError))
      request.complete({
        status: "failed",
        reason: current?.error ?? data?.gitError ?? "unavailable",
      });
    else if (data) {
      heading.current?.focus({ preventScroll: true });
      request.complete({ status: "opened" });
    }
  }, [current, data, gitRequired, request]);
  const go = (next: EntityRoute) => {
    setPath(undefined);
    void open(entityTarget(next, scope));
  };
  const failure = current?.error ?? (gitRequired ? data?.gitError : undefined);
  if (failure)
    return (
      <div role="alert">
        <h1 className="text-title">This destination couldn’t open</h1>
        <p>
          {failure === "not-found"
            ? "The requested entity was not found in this community."
            : "Repository content is unavailable."}
        </p>
        <Button onClick={() => setRefresh((n) => n + 1)}>Retry</Button>
      </div>
    );
  if (!data) return <p role="status">Loading project...</p>;
  if (data.directory)
    return (
      <>
        <h1 ref={heading} tabIndex={-1} className="text-title">
          Projects
        </h1>
        <p className="text-secondary">Recent projects and repositories</p>
        <ul className="project-list">
          {data.directory.map((entity) => (
            <li key={entity.address}>
              <GitBranchIcon size={20} />
              <div>
                <Button
                  variant="link"
                  disabled={!entityDtag(entity.dtag)}
                  title={
                    !entityDtag(entity.dtag)
                      ? "This repository identifier cannot be opened with a Buzz link"
                      : undefined
                  }
                  onClick={() => go(entity)}
                >
                  {entity.name}
                </Button>
                <p>{entity.description}</p>
                <small>{formatPublicKey(entity.owner)}</small>
              </div>
            </li>
          ))}
        </ul>
        {!data.directory.length && (
          <p>No projects or repositories in this community.</p>
        )}
      </>
    );
  const detail = data.detail;
  if (!detail) return null;
  const active =
    route && "id" in route
      ? route.type === "pr"
        ? "prs"
        : "issues"
      : route && "tab" in route
        ? (route.tab ?? "overview")
        : "overview";
  const base = {
    type: detail.entity.type,
    owner: detail.entity.owner,
    dtag: detail.entity.dtag,
  };
  const primary =
    detail.repositories.find((repo) => repo.dtag === detail.entity.dtag) ??
    detail.repositories[0];
  const commit = detail.commit;
  return (
    <>
      <header className="project-heading">
        <div>
          <p className="text-secondary">
            {detail.entity.type === "repo" ? "Repository" : "Project"} ·{" "}
            {formatPublicKey(detail.entity.owner)}
          </p>
          <h1 ref={heading} tabIndex={-1} className="text-title">
            {detail.item
              ? (value(detail.item, "subject") ??
                detail.item.content.split("\n")[0])
              : detail.entity.name}
          </h1>
        </div>
        {route && <CopyLink route={route} />}
      </header>
      {detail.item && (
        <Button variant="link" onClick={() => go(base)}>
          {detail.entity.name}
        </Button>
      )}
      <Tabs
        variant="panel"
        label="Project sections"
        items={tabs}
        value={active}
        onValueChange={(tab) =>
          go({
            ...base,
            ...(tab === "overview"
              ? {}
              : { tab: tab as (typeof entityTabs)[number] }),
          })
        }
      />
      <section className="project-content" aria-label={labels[active]}>
        {detail.entity.type === "project" &&
          ["files", "commits", "contributors"].includes(active) &&
          primary && (
            <div>
              <p>Repository: {primary.name}</p>
              {detail.repositories
                .filter((repo) => repo !== primary)
                .map((repo) => (
                  <Button
                    key={repo.address}
                    variant="link"
                    disabled={!entityDtag(repo.dtag)}
                    onClick={() =>
                      go({
                        type: "repo",
                        owner: repo.owner,
                        dtag: repo.dtag,
                        tab: active as "files" | "commits" | "contributors",
                      })
                    }
                  >
                    {repo.name}
                  </Button>
                ))}
            </div>
          )}
        {detail.item ? (
          <>
            <p>
              {detail.status} · {formatPublicKey(detail.item.pubkey)} ·{" "}
              <time>
                {new Date(detail.item.created_at * 1000).toLocaleString()}
              </time>
            </p>
            <Body text={detail.item.content} open={open} scope={scope} />
            {commit && (
              <p>
                Commit{" "}
                <Button
                  variant="link"
                  onClick={() =>
                    go({ ...base, type: "repo", tab: "commits", commit })
                  }
                >
                  <code>{commit}</code>
                </Button>
              </p>
            )}
            <h2 className="text-heading">Discussion</h2>
            {detail.activity.length ? (
              detail.activity.map((event) => (
                <article className="project-comment" key={event.id}>
                  <p className="text-secondary">
                    {formatPublicKey(event.pubkey)} ·{" "}
                    {new Date(event.created_at * 1000).toLocaleString()}
                  </p>
                  <Body text={event.content} open={open} scope={scope} />
                </article>
              ))
            ) : (
              <p>No comments.</p>
            )}
          </>
        ) : active === "overview" ? (
          <>
            <Body text={detail.entity.description} open={open} scope={scope} />
            {detail.entity.type === "project" && (
              <>
                <h2 className="text-heading">Repositories</h2>
                <ul className="project-list">
                  {detail.repositories.map((repo) => (
                    <li key={repo.address}>
                      <GitBranchIcon size={20} />
                      <Button
                        variant="link"
                        disabled={!entityDtag(repo.dtag)}
                        title={
                          !entityDtag(repo.dtag)
                            ? "This repository identifier cannot be opened with a Buzz link"
                            : undefined
                        }
                        onClick={() => go(repo)}
                      >
                        {repo.name}
                      </Button>
                    </li>
                  ))}
                </ul>
                {!detail.repositories.length && <p>No repositories linked.</p>}
              </>
            )}
            {data.gitError ? (
              <p role="status">
                {data.gitError === "denied"
                  ? "Repository files require access to the linked channel."
                  : "Repository files are unavailable."}{" "}
                <Button variant="link" onClick={() => setRefresh((n) => n + 1)}>
                  Retry files
                </Button>
              </p>
            ) : data.git?.readme ? (
              <Body text={data.git.readme} open={open} scope={scope} />
            ) : (
              detail.entity.type === "repo" && (
                <p>No README in this repository.</p>
              )
            )}
          </>
        ) : active === "prs" || active === "issues" ? (
          <>
            <ul className="project-list">
              {detail.items.map((item) => {
                const repo = detail.repositories.find((repo) =>
                  values(item, "a").includes(repo.address),
                );
                if (!repo) return null;
                return (
                  <li key={item.id}>
                    <Button
                      variant="link"
                      disabled={!entityDtag(repo.dtag)}
                      onClick={() =>
                        go({
                          type: active === "prs" ? "pr" : "issue",
                          owner: repo.owner,
                          dtag: repo.dtag,
                          id: item.id,
                        })
                      }
                    >
                      {value(item, "subject") ?? item.content.split("\n")[0]}
                    </Button>
                    <small>{repo.name}</small>
                  </li>
                );
              })}
            </ul>
            {!detail.items.length && (
              <p>No {labels[active].toLowerCase()} found.</p>
            )}
          </>
        ) : active === "channels" ? (
          <ul className="project-list">
            {detail.channels.map((id) => (
              <li key={id}>
                <Button
                  variant="link"
                  onClick={() =>
                    void open({
                      version: 1,
                      kind: "conversation",
                      scope,
                      channelId: id,
                    })
                  }
                >
                  {session.channels.get?.(id)?.name ?? id}
                </Button>
              </li>
            ))}
            {!detail.channels.length && <li>No linked channels.</li>}
          </ul>
        ) : data.git ? (
          <GitContent
            git={data.git}
            active={active}
            selectFile={setPath}
            selectCommit={(commit) => {
              const repo =
                detail.repositories.find((repo) => repo.dtag === route?.dtag) ??
                detail.repositories[0];
              if (!repo) return;
              go({
                type: "repo",
                owner: repo.owner,
                dtag: repo.dtag,
                tab: "commits",
                commit,
              });
            }}
          />
        ) : (
          <p>No repository linked.</p>
        )}
        {!!detail.unavailableRepositories.length && (
          <p role="status">
            {detail.unavailableRepositories.length} linked repositories are
            unavailable in this community.
          </p>
        )}
      </section>
    </>
  );
}

function GitContent({
  git,
  active,
  selectFile,
  selectCommit,
}: {
  git: GitSnapshot;
  active: string;
  selectFile(path: string | undefined): void;
  selectCommit(hash: string): void;
}) {
  if (active === "files")
    return git.file ? (
      <>
        <Button variant="link" onClick={() => selectFile(undefined)}>
          All files
        </Button>
        <h2 className="text-heading">{git.file.path}</h2>
        {git.file.content !== null ? (
          <pre className="project-code text-code">{git.file.content}</pre>
        ) : (
          <p>Binary file or text larger than 1 MiB ({git.file.size} bytes).</p>
        )}
      </>
    ) : (
      <ul className="project-list">
        {git.files.map((file) => (
          <li key={file.path}>
            <FileTextIcon size={18} />
            <Button variant="link" onClick={() => selectFile(file.path)}>
              {file.path}
            </Button>
            <small>{file.size} bytes</small>
          </li>
        ))}
        {!git.files.length && <li>No files.</li>}
      </ul>
    );
  if (active === "commits")
    return git.diff !== null ? (
      <>
        <h2 className="text-heading">Commit {git.head}</h2>
        <section aria-label="Commit changes">
          <pre className="project-code text-code">{git.diff}</pre>
        </section>
      </>
    ) : (
      <>
        <p className="text-secondary">Latest {git.commits.length} commits</p>
        <ul className="project-list">
          {git.commits.map((commit) => (
            <li key={commit.hash}>
              <Button variant="link" onClick={() => selectCommit(commit.hash)}>
                {commit.subject}
              </Button>
              <small>
                {commit.author} · {commit.hash.slice(0, 10)}
              </small>
            </li>
          ))}
        </ul>
      </>
    );
  const counts = new Map<string, number>();
  for (const commit of git.commits)
    counts.set(commit.author, (counts.get(commit.author) ?? 0) + 1);
  return (
    <>
      <p className="text-secondary">
        Contributors in the latest {git.commits.length} commits
      </p>
      <ul className="project-list">
        {[...counts]
          .sort((a, b) => b[1] - a[1])
          .map(([name, count]) => (
            <li key={name}>
              <span>{name}</span>
              <small>{count} commits</small>
            </li>
          ))}
      </ul>
    </>
  );
}
function CopyLink({ route }: { route: EntityRoute }) {
  const [status, setStatus] = useState("");
  return (
    <div>
      <IconButton
        aria-label="Copy link"
        title="Copy link"
        icon={<CopyIcon size={18} />}
        onClick={() =>
          void navigator.clipboard.writeText(entityHref(route)).then(
            () => setStatus("Link copied"),
            () => setStatus("Could not copy link"),
          )
        }
      />
      <span role="status">{status}</span>
    </div>
  );
}
function Body({
  text,
  open,
  scope,
}: {
  text: string;
  open: Open;
  scope: NavigationScope;
}) {
  return (
    <div className="project-markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) => {
          if (isBuzzLink(url)) return buzzLinkTarget(url, scope) ? url : "";
          return /^(https?:|mailto:)/i.test(url) ? url : "";
        }}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(event) => {
                if (href && isBuzzLink(href)) {
                  event.preventDefault();
                  const target = buzzLinkTarget(href, scope);
                  if (target) void open(target);
                }
              }}
            >
              {children}
            </a>
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}
