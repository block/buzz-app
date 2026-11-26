import { useCallback, useEffect, useMemo, useState } from "react";
import type { RelaySession } from "../relay/session";
import {
  deliverTableAccess,
  missingTableAccess,
  type TableAccessDeps,
} from "./access";

export type TableAccess = Readonly<{
  /** Members who still cannot open the channel's table. */
  missing: readonly string[];
  /** Why the last delivery to a member failed. */
  failures: ReadonlyMap<string, string>;
  pending: ReadonlySet<string>;
  /** The last check of who needs access did not finish. */
  unchecked: boolean;
  grant(member: string): Promise<void>;
  recheck(): void;
}>;

/** Table access for the owner of a private table channel, or `undefined`
 * where the viewer cannot share a table there. */
export function useTableAccess(
  session: RelaySession,
  channelId: string,
  members: readonly string[] | undefined,
  owner: boolean,
): TableAccess | undefined {
  const deps = useMemo<TableAccessDeps | undefined>(() => {
    const { snapshotRead, configArtifactWriter, tableKeys, viewer } = session;
    return owner && snapshotRead && configArtifactWriter && tableKeys && viewer
      ? {
          read: snapshotRead,
          writer: configArtifactWriter,
          host: tableKeys,
          viewer,
        }
      : undefined;
  }, [session, owner]);
  const [missing, setMissing] = useState<readonly string[]>([]);
  const [failures, setFailures] = useState<ReadonlyMap<string, string>>(
    new Map(),
  );
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [generation, setGeneration] = useState(0);
  const [unchecked, setUnchecked] = useState(false);
  const roster = members?.join(",") ?? "";

  // biome-ignore lint/correctness/useExhaustiveDependencies: the roster key and generation reread who still needs access.
  useEffect(() => {
    if (!deps || !members) return;
    const controller = new AbortController();
    missingTableAccess(deps, channelId, members, controller.signal).then(
      (found) => {
        if (controller.signal.aborted) return;
        setMissing(found);
        setUnchecked(false);
      },
      () => {
        if (!controller.signal.aborted) setUnchecked(true);
      },
    );
    return () => controller.abort();
  }, [deps, channelId, roster, generation]);

  const grant = useCallback(
    async (member: string) => {
      if (!deps) return;
      setPending((old) => new Set(old).add(member));
      try {
        await deliverTableAccess(
          deps,
          channelId,
          member,
          AbortSignal.timeout(30_000),
        );
        setFailures((old) => {
          const next = new Map(old);
          next.delete(member);
          return next;
        });
      } catch (error) {
        setFailures((old) =>
          new Map(old).set(
            member,
            error instanceof Error ? error.message : "Access was not granted.",
          ),
        );
      } finally {
        setPending((old) => {
          const next = new Set(old);
          next.delete(member);
          return next;
        });
        setGeneration((value) => value + 1);
      }
    },
    [deps, channelId],
  );

  const recheck = useCallback(() => setGeneration((value) => value + 1), []);
  return deps
    ? { missing, failures, pending, unchecked, grant, recheck }
    : undefined;
}
