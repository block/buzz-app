import { useEffect, useRef, useState, type ReactElement } from "react";
import { CheckIcon, WarningCircleIcon } from "./design-system/icons";
import styles from "./CopyFeedback.module.css";

const results = {
  copied: { Icon: CheckIcon, text: "Copied" },
  failed: { Icon: WarningCircleIcon, text: "Couldn’t copy" },
};

/** One copy control's latest result, for the control to show in place:
 * `copied` for 1.5 seconds, `failed` until the next attempt. `copy` starts a
 * write at once, while the click still counts as the user's, and resolves to
 * how it ended, or to nothing once a newer attempt has begun, so a control
 * that reports a refusal elsewhere reports only the latest. Pass
 * `reportsRefusal` where the button itself shows a refusal; elsewhere `failed`
 * stays false. `status` is the control's `CopyStatus`, to render beside its
 * button: nothing until the first attempt, then in place for good, so a page
 * that copies nothing gains no status. */
export function useCopyFeedback({ reportsRefusal = false } = {}) {
  const [outcome, setOutcome] = useState<keyof typeof results | "none">();
  const generation = useRef(0);
  useEffect(() => {
    if (outcome !== "copied") return;
    const timer = setTimeout(() => setOutcome("none"), 1500);
    return () => clearTimeout(timer);
  }, [outcome]);
  const copied = outcome === "copied";
  const failed = reportsRefusal && outcome === "failed";
  return {
    copied,
    failed,
    status: outcome !== undefined && (
      <CopyStatus copied={copied} failed={failed} />
    ),
    copy(write: () => unknown) {
      const current = ++generation.current;
      const settle = (next: keyof typeof results) => () => {
        if (current !== generation.current) return undefined;
        setOutcome(next);
        return next;
      };
      setOutcome("none");
      return new Promise((written) => written(write())).then(
        settle("copied"),
        settle("failed"),
      );
    },
  };
}

/** The contents of a labelled copy button: its label becomes a check and
 * "Copied". Pass `failed` only where the button also reports a refusal, as a
 * warning and "Couldn’t copy". The button never resizes for a copy that works.
 * Give it an `aria-label`, so its name stays the same in every state, and the
 * hook's `status` beside it. */
export function CopyLabel({
  label,
  icon,
  copied,
  failed = false,
}: {
  /** The resting label, such as "Copy". */
  label: string;
  /** The resting icon, if the button has one. The result's icon replaces it. */
  icon?: ReactElement;
  copied: boolean;
  failed?: boolean;
}) {
  const result = copied ? results.copied : failed ? results.failed : undefined;
  const reserve = result ? label : results.copied.text;
  const resultIcon = result && <result.Icon size={16} aria-hidden="true" />;
  return icon ? (
    <>
      {resultIcon ?? icon}
      <span className={styles.label} data-reserve={reserve}>
        {result?.text ?? label}
      </span>
    </>
  ) : (
    <span className={styles.label} data-reserve={reserve} data-alone="">
      {result ? (
        <span className={styles.result}>
          {resultIcon}
          {result.text}
        </span>
      ) : (
        label
      )}
    </span>
  );
}

/** Repeats a copy control's result for assistive technology, beside a button
 * whose name does not change. It must be in place, empty, before the result
 * fills it: render the `status` that `useCopyFeedback` hands back, or keep
 * this mounted with the control. */
export function CopyStatus({
  copied,
  failed = false,
}: {
  copied: boolean;
  failed?: boolean;
}) {
  return (
    <span role="status" className="sr-only">
      {copied ? results.copied.text : failed ? results.failed.text : null}
    </span>
  );
}
