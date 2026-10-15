import { useId } from "react";
import type { MeshStatus } from "./index";
import styles from "./Compute.module.css";

/** Native byte counts own the fill; the waves only animate its surface. */
export function DownloadProgress({
  download,
}: {
  download: NonNullable<MeshStatus["download"]>;
}) {
  const id = useId();
  const total = download.totalBytes ?? 0;
  const received = Math.max(0, download.downloadedBytes ?? 0);
  const percent =
    total > 0 ? Math.min(100, (received / total) * 100) : undefined;
  return (
    <div className={styles.download}>
      <div
        role="progressbar"
        aria-label="Preparing shared compute"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent === undefined ? undefined : Math.round(percent)}
        aria-valuetext={
          percent === undefined
            ? "Downloading"
            : `${Math.round(percent)}% downloaded`
        }
        className={styles.liquid}
      >
        <svg viewBox="0 0 600 48" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="var(--text-link)" />
              <stop offset="1" stopColor="var(--text-success)" />
            </linearGradient>
            <clipPath id={`${id}-clip`}>
              <rect width="600" height="48" rx="24" />
            </clipPath>
          </defs>
          <g clipPath={`url(#${id}-clip)`}>
            <g
              className={styles.liquidLevel}
              style={{
                transform: `translateX(${percent === undefined ? 180 : percent * 6}px)`,
              }}
            >
              <path
                className={styles.liquidBack}
                fill={`url(#${id}-fill)`}
                d="M -610 -96 H 0 Q 18 -84 0 -72 T 0 -48 T 0 -24 T 0 0 T 0 24 T 0 48 T 0 72 T 0 96 H -610 Z"
              />
              <path
                className={styles.liquidFront}
                fill={`url(#${id}-fill)`}
                d="M -610 -96 H -5 Q 9 -84 -5 -72 T -5 -48 T -5 -24 T -5 0 T -5 24 T -5 48 T -5 72 T -5 96 H -610 Z"
              />
            </g>
          </g>
        </svg>
      </div>
      <p className="m-0 text-body-sm text-secondary tabular-nums">
        {percent === undefined
          ? "Downloading…"
          : `${Math.round(percent)}% downloaded`}
        {total > 0 &&
          ` · ${(received / 1e9).toFixed(2)} of ${(total / 1e9).toFixed(2)} GB`}
      </p>
    </div>
  );
}
