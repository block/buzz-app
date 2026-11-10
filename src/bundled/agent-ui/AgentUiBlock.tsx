import { lazy, Suspense, useMemo } from "react";
import { parseAgentUi } from "./spec";
import styles from "./AgentUi.module.css";

const AgentUiCard = lazy(() => import("./AgentUiCard"));

/** The conversation host owns the frame, source copy and failure boundary. */
export function AgentUiBlock({ code }: { code: string }) {
  const spec = useMemo(() => parseAgentUi(code), [code]);
  const source = <div className={styles.source}>{code}</div>;
  if (!spec) return source;
  return (
    <Suspense fallback={source}>
      <AgentUiCard key={code} spec={spec} />
    </Suspense>
  );
}
