import {
  useCallback,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { OpenTarget } from "../navigation/targets";
import type { Navigation } from "../navigation/controller";
import { isSelectedDestination } from "./sidebar-destinations";
import { OwnedContribution } from "../../plugins/OwnedContribution";
import { NavigationSection } from "../../shared/design-system/ui/NavigationSection";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  CaretDownIcon,
  CaretRightIcon,
} from "../../shared/design-system/icons";
import { readView, writeView } from "../../shared/view-state";
import type {
  RegisteredSidebarSection,
  SidebarSections,
} from "./sidebar-sections-service";

type Frames = {
  fullPage?: boolean | undefined;
  only?: string;
  rowId?: string | undefined;
  fallbackRow?: ReactNode;
  renderSection?:
    | ((props: {
        label: string;
        action: ReactNode;
        children: ReactNode;
        items: readonly {
          id: string;
          label: string;
          target: OpenTarget;
          content: ReactNode;
        }[];
        note: ReactNode;
      }) => ReactNode)
    | undefined;
  renderRow?:
    | ((
        id: string,
        label: string,
        target: OpenTarget,
        content: ReactNode,
      ) => ReactNode)
    | undefined;
};

/** A host for the existing contribution contract, sharing the rail's row owners. */
export function ContributedRailSections({
  registry,
  navigator,
  partition,
  only,
  renderSection,
  renderRow,
  rowId,
  fallbackRow,
  fullPage,
}: {
  registry: SidebarSections;
  navigator: Navigation;
  partition: string;
} & Frames) {
  const entries = useSyncExternalStore(registry.subscribe, registry.snapshot);
  return (
    <>
      {entries
        .filter((entry) => !only || entry.key === only)
        .map((entry) => (
          <OwnedContribution
            key={entry.key}
            entry={entry}
            registry={registry}
            fallback={
              <p role="alert" className="text-caption text-secondary">
                {entry.title} is unavailable.
              </p>
            }
          >
            {(section, active) => (
              <Section
                entry={section}
                navigator={navigator}
                partition={partition}
                active={active}
                renderSection={renderSection}
                renderRow={renderRow}
                rowId={rowId}
                fallbackRow={fallbackRow}
                fullPage={fullPage}
              />
            )}
          </OwnedContribution>
        ))}
    </>
  );
}
function Section({
  entry,
  navigator,
  partition,
  active,
  renderSection,
  renderRow,
  rowId,
  fallbackRow,
  fullPage,
}: {
  entry: RegisteredSidebarSection;
  navigator: Navigation;
  partition: string;
  active(): boolean;
} & Frames) {
  const subscribe = useCallback(
    (listener: () => void) => entry.rows.subscribe(listener),
    [entry.rows],
  );
  const read = useCallback(() => entry.rows.snapshot(), [entry.rows]);
  const rows = useSyncExternalStore(subscribe, read);
  const ids = new Set<string>();
  for (const row of rows) {
    if (
      !row ||
      typeof row.id !== "string" ||
      !row.id ||
      ids.has(row.id) ||
      typeof row.label !== "string"
    )
      throw new Error("Invalid sidebar rows");
    ids.add(row.id);
  }
  const navigation = useSyncExternalStore(
    navigator.subscribe,
    navigator.snapshot,
  );
  const [open, setOpen] = useState(() =>
    readView(partition, `rail-section:${entry.key}`, true),
  );
  const [error, setError] = useState("");

  const run = (action: () => unknown) => {
    if (!active()) return;
    setError("");
    try {
      Promise.resolve(action()).catch(() => {
        if (active()) setError("Couldn’t open this section. Try again.");
      });
    } catch {
      setError("This section is unavailable. Try again.");
    }
  };
  const action = (
    <>
      {entry.actions?.map((action) => (
        <IconButton
          key={action.id}
          aria-label={action.label}
          size="sm"
          variant="ghost"
          icon={action.icon}
          onClick={() => run(() => action.onSelect())}
        />
      ))}
      {!fullPage && (
        <IconButton
          aria-label={`${open ? "Collapse" : "Expand"} ${entry.title}`}
          aria-expanded={open}
          size="sm"
          variant="ghost"
          icon={
            open ? (
              <CaretDownIcon size={16} strokeWidth={2} />
            ) : (
              <CaretRightIcon size={16} strokeWidth={2} />
            )
          }
          onClick={() => {
            setOpen(!open);
            writeView(partition, `rail-section:${entry.key}`, !open);
          }}
        />
      )}
    </>
  );
  const items =
    rowId || open || fullPage
      ? rows
          .filter((row) => !rowId || row.id === rowId)
          .map((row) => {
            const destination = entry.select(row);
            const content = (
              <NavigationItem
                key={row.id}
                label={row.label}
                icon={row.icon ?? entry.icon}
                selected={isSelectedDestination(
                  destination,
                  navigation.entry.target,
                )}
                trailing={
                  (row.badge || row.status || row.count !== undefined) && (
                    <span className="text-caption text-secondary">
                      {row.badge ?? row.status ?? row.count}
                    </span>
                  )
                }
                onClick={() =>
                  run(async () => {
                    const result = await navigator.open(destination);
                    if (result.status === "failed")
                      throw new Error("Unavailable");
                  })
                }
              />
            );
            return {
              id: row.id,
              label: row.label,
              target: destination,
              content,
            };
          })
      : [];
  const note = error && (
    <p role="alert" className="text-caption text-danger">
      {error}
    </p>
  );
  const children = [
    rowId && !rows.some((row) => row.id === rowId) && fallbackRow,
    ...items.map((item) =>
      renderRow
        ? renderRow(item.id, item.label, item.target, item.content)
        : item.content,
    ),
    note,
  ];
  return renderSection ? (
    renderSection({ label: entry.title, action, children, items, note })
  ) : (
    <NavigationSection label={entry.title} action={action}>
      {children}
    </NavigationSection>
  );
}
