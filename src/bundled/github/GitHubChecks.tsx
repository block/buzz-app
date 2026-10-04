import { useEffect, useRef, useState } from "react";
import {
  CheckCircleIcon,
  CheckIcon,
  CircleDashedIcon,
  DotsThreeIcon,
  LinkIcon,
  WarningCircleIcon,
  XCircleIcon,
} from "../../shared/design-system/icons/index";
import { Accordion } from "../../shared/design-system/ui/Accordion";
import { Tooltip } from "../../shared/design-system/ui/Tooltip";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuIcon,
} from "../../shared/design-system/ui/Menu";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import {
  loadGitHubChecks,
  unavailableChecks,
  type CheckSummary,
  type CheckDetail,
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
  successful: CheckIcon,
  skipped: CircleDashedIcon,
  neutral: CircleDashedIcon,
};

const groups: { category: CheckDetail["category"]; label: string }[] = [
  { category: "failing", label: "failing" },
  { category: "cancelled", label: "cancelled" },
  { category: "pending", label: "pending" },
  { category: "unknown", label: "unknown" },
  { category: "skipped", label: "skipped" },
  { category: "neutral", label: "neutral" },
  { category: "successful", label: "successful" },
];

function CheckActions({ url, name }: { url: string; name: string }) {
  const [open, setOpen] = useState(false);
  const [copying, setCopying] = useState(false);
  const busy = useRef(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean }>();
  async function copy() {
    if (busy.current) return;
    busy.current = true;
    setCopying(true);
    setNotice(undefined);
    try {
      await navigator.clipboard.writeText(url);
      setNotice({ text: "Link copied", error: false });
    } catch {
      setNotice({
        text: "Couldn’t copy the link. Try again from the check actions.",
        error: true,
      });
    } finally {
      busy.current = false;
      setCopying(false);
    }
  }
  return (
    <div className={styles.checkActions} data-menu-open={open || undefined}>
      <MenuRoot open={open} onOpenChange={setOpen}>
        <MenuTrigger
          render={
            <IconButton
              aria-label={`Actions for ${name}`}
              size="xs"
              icon={<DotsThreeIcon />}
            />
          }
        />
        <MenuPopup align="end">
          <MenuItem disabled={copying} onClick={() => void copy()}>
            <MenuIcon>
              <LinkIcon />
            </MenuIcon>
            Copy link
          </MenuItem>
        </MenuPopup>
      </MenuRoot>
      {notice && (
        <ToastNotice
          title={notice.text}
          tone={notice.error ? "error" : "success"}
          timeout={notice.error ? 0 : 4000}
          onDismiss={() => setNotice(undefined)}
        />
      )}
    </div>
  );
}

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
  const total = result.checks?.length ?? 0;
  const sections = groups
    .map((group) => ({
      ...group,
      checks:
        result.checks?.filter((check) => check.category === group.category) ??
        [],
    }))
    .filter((group) => group.checks.length);
  let offset = 0;
  return (
    <div data-buzz-ui="" className={styles.checksCard}>
      <Tooltip content={result.description} delay={300}>
        {/* Counts are supplementary text, made focusable for the requested keyboard tooltip. */}
        <span
          // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users need access to the counts tooltip.
          tabIndex={0}
          className={styles.checkSummary}
          data-check-state={result.state}
        >
          {total && result.state !== "unavailable" ? (
            <svg width="32" height="32" viewBox="0 0 32 32" aria-hidden="true">
              {sections.map((group) => {
                const length = (group.checks.length / total) * 100;
                const start = offset;
                offset += length;
                return (
                  <circle
                    key={group.category}
                    data-check-category={group.category}
                    className={styles.checkSegment}
                    cx="16"
                    cy="16"
                    r="13"
                    pathLength="100"
                    strokeDasharray={`${length} 100`}
                    strokeDashoffset={-start}
                    transform="rotate(-90 16 16)"
                  />
                );
              })}
            </svg>
          ) : (
            <Icon size={32} aria-hidden="true" />
          )}
          <span className={`text-label ${styles.checkSummaryLabel}`}>
            {result.state === "failure"
              ? "Some checks were not successful"
              : result.label}
          </span>
          <span className={`text-caption ${styles.checksDescription}`}>
            {result.description}
          </span>
        </span>
      </Tooltip>
      {sha &&
        (result.state === "unavailable" ||
          result.checks?.some((check) => check.category === "unknown")) && (
          <div className={styles.checksRetry}>
            <Button
              variant="link"
              size="xs"
              onClick={() => retry(attempt + 1)}
              aria-label="Retry checks"
            >
              Retry
            </Button>
          </div>
        )}
      {!!total && (
        <div className={styles.checkGroups}>
          <Accordion
            variant="activity"
            keepMounted
            defaultValue={groups
              .filter((group) => group.category !== "skipped")
              .map((group) => group.category)}
            items={sections.map((group) => ({
              value: group.category,
              title: `${group.checks.length} ${group.label} ${group.checks.length === 1 ? "check" : "checks"}`,
              content: (
                <ul
                  className={styles.checkList}
                  aria-label={`${group.label} checks on the PR head commit`}
                >
                  {group.checks.map((check) => {
                    const CheckIcon = checkIcons[check.category];
                    return (
                      <li
                        key={check.key}
                        className={styles.checkRow}
                        data-check-category={check.category}
                      >
                        <CheckIcon size={18} aria-hidden="true" />
                        <div className={styles.checkContent}>
                          <div className={styles.checkHeading}>
                            {check.url ? (
                              <a
                                className={`${inlineStyles.link} ${styles.checkName}`}
                                href={check.url}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {check.name}
                              </a>
                            ) : (
                              <span>{check.name}</span>
                            )}
                            <span
                              className={`text-caption ${styles.checkResult}`}
                            >
                              {check.label}
                            </span>
                          </div>
                          {check.description && (
                            <p
                              className={`text-caption ${styles.checksDescription}`}
                            >
                              {check.description}
                            </p>
                          )}
                        </div>
                        {check.url && (
                          <CheckActions url={check.url} name={check.name} />
                        )}
                      </li>
                    );
                  })}
                </ul>
              ),
            }))}
          />
        </div>
      )}
    </div>
  );
}
