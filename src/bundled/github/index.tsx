import { Button } from "../../shared/design-system/ui/Button";
import { useEffect, useId, useMemo, useState } from "react";
import {
  ArrowSquareOutIcon,
  GitPullRequestIcon,
  GitHubIssueIcon,
  GitCommitIcon,
  FolderSimpleIcon,
} from "../../shared/design-system/icons/index";
import type { PluginModule } from "../../plugins/api";
import type { PanelProps } from "../../features/panels/service";
import { parseGitHubReference, type GitHubReference } from "./references";
import { loadGitHubDetails, type GitHubDetails } from "./data";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { GitHubChecks } from "./GitHubChecks";
import styles from "./GitHub.module.css";
import { GitHubBody } from "./GitHubBody";

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
  return (
    <div className={styles.root}>
      <div className={styles.identity}>
        <span className={styles.icon}>
          <Icon size={22} aria-hidden="true" />
        </span>
        <div>
          <small>{reference.repository}</small>
          <strong>
            {labels[reference.kind]} {reference.label}
          </strong>
        </div>
      </div>
      <a
        className={styles.external}
        href={reference.url}
        target="_blank"
        rel="noreferrer"
      >
        Open on GitHub <ArrowSquareOutIcon size={14} />
      </a>
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
          <div className={styles.byline}>
            {result.state && (
              <span className={styles.state}>{result.state}</span>
            )}
            {result.author && <span>by {result.author}</span>}
          </div>
          <h2>{result.title}</h2>
          {!!result.facts.length && (
            <dl className={styles.facts}>
              {result.facts.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          )}
          {reference.kind === "pull" ? (
            <PullContent details={result} reference={reference} />
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
      <p className={styles.note}>
        Public GitHub data · Open on GitHub for private repositories and
        actions.
      </p>
    </div>
  );
}

function PullContent({
  details,
  reference,
}: {
  details: GitHubDetails;
  reference: GitHubReference;
}) {
  const id = useId();
  const [tab, setTab] = useState<"discussion" | "checks">("discussion");
  const [checksOpened, setChecksOpened] = useState(false);
  return (
    <>
      <div className={styles.pullTabs}>
        <Tabs
          variant="panel"
          label="Pull request content"
          value={tab}
          items={[
            {
              value: "discussion",
              label: "Discussion",
              panelId: `${id}-discussion`,
            },
            { value: "checks", label: "Checks", panelId: `${id}-checks` },
          ]}
          onValueChange={(next) => {
            setTab(next);
            if (next === "checks") setChecksOpened(true);
          }}
        />
      </div>
      {/* Retain loaded content and disclosures across tab switches, but mount checks only on demand. */}
      <div
        role="tabpanel"
        id={`${id}-discussion`}
        aria-labelledby={`${id}-discussion-tab`}
        hidden={tab !== "discussion"}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: tab panels are keyboard destinations linked by the shared tabs.
        tabIndex={0}
      >
        {details.body && (
          <GitHubBody
            body={details.body}
            bodyHtml={details.bodyHtml}
            url={reference.url}
          />
        )}
      </div>
      <div
        role="tabpanel"
        id={`${id}-checks`}
        aria-labelledby={`${id}-checks-tab`}
        hidden={tab !== "checks"}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: tab panels are keyboard destinations linked by the shared tabs.
        tabIndex={0}
      >
        {checksOpened && (
          <GitHubChecks
            repository={reference.repository}
            sha={details.headSha}
          />
        )}
      </div>
    </>
  );
}
