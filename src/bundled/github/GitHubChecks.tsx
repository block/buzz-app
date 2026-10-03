import { useEffect, useState } from "react";
import {
  CheckCircleIcon,
  CircleDashedIcon,
  WarningCircleIcon,
  XCircleIcon,
} from "../../shared/design-system/icons/index";
import { Tooltip } from "../../shared/design-system/ui/Tooltip";
import { Button } from "../../shared/design-system/ui/Button";
import {
  loadGitHubChecks,
  unavailableChecks,
  type CheckSummary,
} from "./checks";
import styles from "./GitHub.module.css";
import inlineStyles from "../../shared/InlineReference.module.css";

const loading: CheckSummary = {
  state: "neutral",
  label: "Loading…",
  description: "Loading checks on the PR head commit.",
};
const icons = {
  failure: XCircleIcon,
  pending: WarningCircleIcon,
  success: CheckCircleIcon,
  neutral: CircleDashedIcon,
  unavailable: WarningCircleIcon,
};

const checkIcons = {
  failing: XCircleIcon,
  cancelled: XCircleIcon,
  pending: WarningCircleIcon,
  unknown: WarningCircleIcon,
  successful: CheckCircleIcon,
  skipped: CircleDashedIcon,
  neutral: CircleDashedIcon,
};

export function GitHubChecks({
  repository,
  sha,
}: {
  repository: string;
  sha?: string | undefined;
}) {
  const [result, setResult] = useState(sha ? loading : unavailableChecks);
  const [attempt, retry] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is the explicit user-requested retry trigger.
  useEffect(() => {
    if (!sha) return;
    const controller = new AbortController();
    setResult(loading);
    void loadGitHubChecks(
      repository,
      sha,
      AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
    ).then((summary) => {
      if (!controller.signal.aborted) setResult(summary);
    });
    return () => controller.abort();
  }, [repository, sha, attempt]);
  const Icon = icons[result.state];
  return (
    <div data-buzz-ui="">
      <Tooltip content={result.description} delay={300}>
        {/* Counts are supplementary text, made focusable for the requested keyboard tooltip. */}
        <span
          // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users need access to the counts tooltip.
          tabIndex={0}
          className={`text-body-lg ${styles.checkSummary}`}
          data-check-state={result.state}
        >
          <Icon size={18} aria-hidden="true" />
          {result.label}
        </span>
      </Tooltip>
      <p className={`text-caption ${styles.checksDescription}`}>
        {result.description}
      </p>
      {result.state === "unavailable" && sha && (
        <Button
          variant="link"
          size="xs"
          onClick={() => retry(attempt + 1)}
          aria-label="Retry checks"
        >
          Retry
        </Button>
      )}
      {!!result.checks?.length && (
        <ul
          className={styles.checkList}
          aria-label="Checks on the PR head commit"
        >
          {result.checks.map((check) => {
            const CheckIcon = checkIcons[check.category];
            return (
              <li
                key={check.key}
                className={styles.checkRow}
                data-check-category={check.category}
              >
                <CheckIcon size={16} aria-hidden="true" />
                <div className={styles.checkContent}>
                  <div className={styles.checkHeading}>
                    {check.url ? (
                      <a
                        className={inlineStyles.link}
                        href={check.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {check.name}
                      </a>
                    ) : (
                      <span>{check.name}</span>
                    )}
                    <span className={`text-caption ${styles.checkResult}`}>
                      {check.label}
                    </span>
                  </div>
                  {check.description && (
                    <p className={`text-caption ${styles.checksDescription}`}>
                      {check.description}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
