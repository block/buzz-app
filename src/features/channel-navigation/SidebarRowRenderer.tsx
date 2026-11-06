import { useIsPresent } from "motion/react";
import {
  isValidElement,
  useLayoutEffect,
  useMemo,
  type ReactElement,
} from "react";
import { ContributionBoundary } from "../conversation/ContributionBoundary";
import type {
  RegisteredSidebarRows,
  SidebarRow,
  SidebarRowHiddenChange,
} from "./sidebar-rows-service";

export function SidebarRowRenderer({
  row,
  entries,
  children,
  onHiddenChange,
}: {
  row: SidebarRow;
  entries: readonly RegisteredSidebarRows[];
  children: ReactElement;
  onHiddenChange?: SidebarRowHiddenChange | undefined;
}) {
  const present = useIsPresent();
  const resetIdentity = useMemo(() => [entries, row], [entries, row]);
  let result: ReactElement | null = children;
  let label: string | undefined;
  try {
    for (const entry of entries) {
      if (!entry.render) continue;
      const before = result;
      result = entry.render(row, result);
      if (result !== null && !isValidElement(result))
        throw new Error("Invalid sidebar row render result");
      if (before !== null && result === null) label = entry.hiddenLabel;
    }
  } catch {
    result = children;
  }
  const hidden = result === null;
  if (!hidden) label = undefined;
  useLayoutEffect(() => {
    if (present) return onHiddenChange?.(row.id, hidden, label);
  }, [onHiddenChange, row.id, hidden, label, present]);
  return (
    <ContributionBoundary fallback={children} resetIdentity={resetIdentity}>
      {result}
    </ContributionBoundary>
  );
}
