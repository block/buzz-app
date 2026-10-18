import { Button } from "../../shared/design-system/ui/Button";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowSquareOutIcon,
  GitPullRequestIcon,
  CircleDashedIcon,
  XCircleIcon,
  GitMergeIcon,
  GitHubIssueIcon,
  GitCommitIcon,
  FolderSimpleIcon,
} from "../../shared/design-system/icons/index";
import type { PluginModule } from "../../plugins/api";
import type { PanelProps } from "../../features/panels/service";
import { parseGitHubReference, type GitHubReference } from "./references";
import { gitHubCli, type GitHubCli } from "./gh";
import { loadGitHubObject, type GitHubObject } from "./object";
import { Accordion } from "../../shared/design-system/ui/Accordion";
import { PublicChecklist, PullChecklist } from "./PullChecklist";
import styles from "./GitHub.module.css";
import inlineStyles from "../../shared/InlineReference.module.css";
import { GitHubBody } from "./GitHubBody";
import { relativeTimestamp } from "../../shared/relative-timestamp";

/** How often an open pull request panel reads GitHub again. */
export const REFRESH_MS = 30_000;

export const inject = ["panels", "host"];
export const apply: PluginModule["apply"] = (ctx) => {
  const gh = gitHubCli(ctx.host);
  ctx.panels.register({
    id: "object",
    title: "GitHub",
    matches: (target) => !!parseGitHubReference(target),
    component: (props: PanelProps) => <GitHubPanel {...props} gh={gh} />,
  });
};
const labels = {
  repository: "Repository",
  pull: "Pull request",
  issue: "Issue",
  commit: "Commit",
};
const icons = {
  repository: FolderSimpleIcon,
  pull: GitPullRequestIcon,
  issue: GitHubIssueIcon,
  commit: GitCommitIcon,
};

const stateIcons = {
  open: GitPullRequestIcon,
  draft: CircleDashedIcon,
  closed: XCircleIcon,
  merged: GitMergeIcon,
};

export function GitHubPanel({
  target,
  gh,
}: PanelProps & {
  /** The person's `gh`, where the app can run it. */
  gh?: GitHubCli | undefined;
}) {
  const [attempt, retry] = useState(0);
  const reference = useMemo(() => parseGitHubReference(target), [target]);
  return reference ? (
    <ObjectPanel
      key={`${reference.url}:${attempt}`}
      reference={reference}
      gh={gh}
      retry={() => retry(attempt + 1)}
    />
  ) : (
    <p className="notice">Unsupported GitHub link.</p>
  );
}

function ObjectPanel({
  reference,
  gh,
  retry,
}: {
  reference: GitHubReference;
  gh: GitHubCli | undefined;
  retry(): void;
}) {
  const [loaded, setLoaded] = useState<GitHubObject | string>();
  const link = reference.url;
  const live = useRef<AbortController>(undefined);
  /** Reads it again. A failed refresh keeps what is shown; only the first
   * read shows an error. */
  const load = useCallback(async () => {
    live.current?.abort();
    const controller = new AbortController();
    live.current = controller;
    try {
      const next = await loadGitHubObject(
        reference,
        AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
        gh,
      );
      if (!controller.signal.aborted) setLoaded(next);
    } catch (error) {
      if (!controller.signal.aborted)
        setLoaded((current) =>
          typeof current === "object"
            ? current
            : error instanceof Error
              ? error.message
              : String(error),
        );
    }
  }, [reference, gh]);
  useEffect(() => {
    void load();
    return () => live.current?.abort();
  }, [load]);
  const watching = typeof loaded === "object" && !!loaded.checklist;
  useEffect(() => {
    if (!watching) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [watching, load]);
  const result = typeof loaded === "object" ? loaded.details : loaded;
  const Icon = icons[reference.kind];
  const state = typeof result === "object" ? result.state.toLowerCase() : "";
  const StateIcon =
    reference.kind === "pull" && Object.hasOwn(stateIcons, state)
      ? stateIcons[state as keyof typeof stateIcons]
      : undefined;
  const [owner, repositoryName] = reference.repository.split("/");
  const title = (
    <h2 className={reference.kind === "pull" ? styles.pullTitle : undefined}>
      {reference.kind === "pull" ? (
        <a
          className={`${inlineStyles.link} ${styles.titleLink}`}
          href={link}
          target="_blank"
          rel="noreferrer"
        >
          {typeof result === "object" ? result.title : labels.pull}{" "}
          <span className={styles.titleNumber}>{reference.label}</span>
        </a>
      ) : (
        typeof result === "object" && result.title
      )}
    </h2>
  );
  return (
    <div className={styles.root}>
      <div className={styles.identity}>
        <span className={styles.icon}>
          <Icon size={22} aria-hidden="true" />
        </span>
        <div>
          {reference.kind === "pull" ? (
            <>
              <div className={styles.repository}>
                <a
                  className={inlineStyles.link}
                  href={`https://github.com/${owner}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {owner}
                </a>
                <span className={styles.repositorySeparator}> / </span>
                <a
                  className={inlineStyles.link}
                  href={`https://github.com/${reference.repository}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {repositoryName}
                </a>
              </div>
              <small>{labels[reference.kind]}</small>
            </>
          ) : (
            <>
              <small>{reference.repository}</small>
              <strong>
                {labels[reference.kind]} {reference.label}
              </strong>
            </>
          )}
        </div>
      </div>
      {reference.kind !== "pull" && (
        <a
          className={styles.external}
          href={reference.url}
          target="_blank"
          rel="noreferrer"
        >
          Open on GitHub <ArrowSquareOutIcon size={14} />
        </a>
      )}
      {reference.kind === "pull" && typeof result !== "object" && title}
      {result === undefined ? (
        <p role="status">Loading from GitHub…</p>
      ) : typeof result === "string" ? (
        <div role="alert">
          <p>{result}</p>
          <div className={styles.errorActions}>
            <Button
              variant="prominent"
              nativeButton={false}
              role="link"
              render={
                <a
                  className={styles.errorExternal}
                  href={link}
                  target="_blank"
                  rel="noreferrer"
                />
              }
            >
              <span className={styles.errorActionLabel}>Open on Github</span>
            </Button>
            <Button type="button" onClick={retry}>
              Retry
            </Button>
          </div>
        </div>
      ) : (
        <>
          {reference.kind === "pull" && title}
          <div className={styles.byline}>
            {result.state && (
              <span
                className={styles.state}
                data-pr-state={
                  reference.kind === "pull"
                    ? result.state.toLowerCase()
                    : undefined
                }
              >
                {StateIcon && <StateIcon size={12} aria-hidden="true" />}
                {result.state}
              </span>
            )}
            {result.author && (
              <span>
                by{" "}
                {result.authorUrl ? (
                  <a
                    className={inlineStyles.link}
                    href={result.authorUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {result.author}
                  </a>
                ) : (
                  result.author
                )}
              </span>
            )}
          </div>
          {reference.kind !== "pull" && title}
          {(!!result.facts.length || reference.kind === "pull") && (
            <dl className={styles.facts}>
              {result.facts.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>
                    {typeof value !== "object" ? (
                      value
                    ) : "head" in value ? (
                      <>
                        {value.head.url ? (
                          <a
                            className={styles.branch}
                            href={value.head.url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {value.head.label}
                          </a>
                        ) : (
                          <span className={styles.branchLabel}>
                            {value.head.label}
                          </span>
                        )}
                        {" → "}
                        {value.base.url ? (
                          <a
                            className={styles.branch}
                            href={value.base.url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {value.base.label}
                          </a>
                        ) : (
                          <span className={styles.branchLabel}>
                            {value.base.label}
                          </span>
                        )}
                      </>
                    ) : (
                      <>
                        <span className={styles.additions}>
                          +{value.additions}
                        </span>
                        {" / "}
                        <span className={styles.deletions}>
                          −{value.deletions}
                        </span>
                      </>
                    )}
                  </dd>
                </div>
              ))}
              {reference.kind === "pull" && (
                <div>
                  <dt>Last updated</dt>
                  <dd>
                    {result.updatedAt ? (
                      <time
                        dateTime={result.updatedAt}
                        title={new Date(result.updatedAt).toLocaleString()}
                      >
                        {relativeTimestamp(Date.parse(result.updatedAt) / 1000)}
                      </time>
                    ) : (
                      "Unavailable"
                    )}
                  </dd>
                </div>
              )}
            </dl>
          )}
          {reference.kind === "pull" ? (
            <>
              {typeof loaded === "object" && loaded.checklist && gh ? (
                <PullChecklist
                  url={reference.url}
                  details={result}
                  checklist={loaded.checklist}
                  gh={gh}
                  refresh={load}
                />
              ) : (
                <PublicChecklist
                  url={reference.url}
                  repository={reference.repository}
                  sha={result.headSha}
                />
              )}
              {result.body && (
                <div className={styles.description}>
                  <Accordion
                    variant="activity"
                    items={[
                      {
                        value: "description",
                        title: "Description",
                        content: (
                          <GitHubBody
                            body={result.body}
                            bodyHtml={result.bodyHtml}
                            url={reference.url}
                          />
                        ),
                      },
                    ]}
                  />
                </div>
              )}
            </>
          ) : (
            result.body && (
              <GitHubBody
                body={result.body}
                bodyHtml={result.bodyHtml}
                url={reference.url}
              />
            )
          )}
        </>
      )}
      {typeof loaded === "object" && (
        <p className={styles.note}>
          {loaded.signedIn
            ? "Read with your gh sign-in."
            : "Public GitHub data · Sign in to the gh CLI to see private repositories and merge from here."}
        </p>
      )}
    </div>
  );
}
