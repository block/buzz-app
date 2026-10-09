import { useEffect, useRef, type ReactNode } from "react";
import styles from "./Compute.module.css";

/** Read-only fields projected by the existing native mesh owner. */
export type ActivityStatus = {
  generation?: number;
  available: boolean;
  lifecycle?: { state: string };
  usage?: {
    tokensServed: number | null;
    inflight: number | null;
    tokensPerSecond: number | null;
    peers: number | null;
  } | null;
};

/** Embed Thomas Petersen's original canvas in an IPC-free, scoped document. */
export function ComputeActivity({
  status,
  children,
}: {
  status: ActivityStatus | null;
  children?: ReactNode;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const latest = useRef(status);
  latest.current = status;
  const send = () => {
    const current = latest.current;
    frame.current?.contentWindow?.postMessage(
      {
        type: "buzz-mesh-activity",
        status: {
          generation: current?.generation ?? 0,
          state:
            current?.lifecycle?.state === "ready"
              ? "running"
              : current?.lifecycle?.state === "starting"
                ? "starting"
                : current?.lifecycle?.state === "failed"
                  ? "failed"
                  : "off",
          usage: current?.usage ?? null,
        },
      },
      "*", // sandbox has an opaque origin; only this window receives the message.
    );
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: status changes push the latest ref; load also sends the current value.
  useEffect(send, [status]);
  return (
    <>
      <div className={styles.machineOverview}>
        <iframe
          ref={frame}
          src="/compute-widget.html"
          title="Shared-compute bee visualization"
          sandbox="allow-scripts"
          onLoad={send}
          className={styles.activityTile}
        />
        {children}
      </div>
      <section aria-label="Shared-compute activity" className={styles.activity}>
        <div className={styles.sharingHeader}>
          <h3 className="m-0 text-body">Shared-compute activity</h3>
          <span className="text-body text-secondary font-mono">
            {status?.lifecycle?.state === "starting"
              ? "Starting"
              : status?.lifecycle?.state === "failed"
                ? "Failed"
                : (status?.usage?.inflight ?? 0) > 0
                  ? "Working"
                  : "Standby"}
          </span>
        </div>
        <dl className={styles.activityMetrics}>
          {[
            ["Output tokens", status?.usage?.tokensServed],
            ["Completed requests", null],
            ["Other sharing nodes", null],
            ["Tokens / sec (avg)", status?.usage?.tokensPerSecond],
          ].map(([label, value]) => (
            <div key={label} className={styles.metricTile}>
              <dt className="text-body text-secondary">{label}</dt>
              <dd className="m-0 text-title font-mono">{value ?? "—"}</dd>
            </div>
          ))}
        </dl>
        <details>
          <summary className="text-body text-secondary">Details</summary>
          <p className="text-body-sm text-secondary">
            Counters show session-observed completion tokens and known peers,
            not this machine’s contribution. Completed requests are not
            reported. Focus the tile and use Left/Right to switch designs.
          </p>
        </details>
      </section>
    </>
  );
}
