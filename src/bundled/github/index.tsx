import { Button } from "../../shared/design-system/ui/Button";
import { useEffect, useMemo, useState } from "react";
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
import { loadGitHubDetails, type GitHubDetails } from "./data";
import styles from "./GitHub.module.css";
import inlineStyles from "../../shared/InlineReference.module.css";
import { GitHubBody } from "./GitHubBody";
import { GitHubChecks } from "./GitHubChecks";
import { relativeTimestamp } from "../../shared/relative-timestamp";

export const inject = ["panels"];
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.panels.register({
    id: "object",
    title: "GitHub",
    matches: (target) => !!parseGitHubReference(target),
    component: GitHubPanel,
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

export function GitHubPanel({ target }: PanelProps) {
  const [attempt, retry] = useState(0);
  const reference = useMemo(() => parseGitHubReference(target), [target]);
  return reference ? (
    <ObjectPanel
      key={`${reference.url}:${attempt}`}
      reference={reference}
      retry={() => retry(attempt + 1)}
    />
  ) : (
    <p className="notice">Unsupported GitHub link.</p>
  );
}

function ObjectPanel({
  reference,
  retry,
}: {
  reference: GitHubReference;
  retry(): void;
}) {
  const [result, setResult] = useState<GitHubDetails | string>();
  useEffect(() => {
    const controller = new AbortController();
    setResult(undefined);
    void loadGitHubDetails(
      reference,
      AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
    )
      .then((details) => {
        if (!controller.signal.aborted) setResult(details);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setResult(error instanceof Error ? error.message : String(error));
      });
    return () => controller.abort();
  }, [reference]);
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
          href={reference.url}
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
          <Button type="button" onClick={retry}>
            Try again
          </Button>
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
                <>
                  <div>
                    <dt>Checks</dt>
                    <dd>
                      <GitHubChecks
                        repository={reference.repository}
                        sha={result.headSha}
                      />
                    </dd>
                  </div>
                  <div>
                    <dt>Last updated</dt>
                    <dd>
                      {result.updatedAt ? (
                        <time
                          dateTime={result.updatedAt}
                          title={new Date(result.updatedAt).toLocaleString()}
                        >
                          {relativeTimestamp(
                            Date.parse(result.updatedAt) / 1000,
                          )}
                        </time>
                      ) : (
                        "Unavailable"
                      )}
                    </dd>
                  </div>
                </>
              )}
            </dl>
          )}
          {result.body && (
            <GitHubBody
              body={result.body}
              bodyHtml={result.bodyHtml}
              url={reference.url}
            />
          )}
        </>
      )}
      <p className={styles.note}>
        Public GitHub data · Open on GitHub for private repositories and
        actions.
      </p>
    </div>
  );
}
