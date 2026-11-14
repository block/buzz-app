import type { ReactNode } from "react";
import type { RailEntry } from "./rail-pins";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Input } from "../../shared/design-system/ui/Input";
import { SidebarNavigation } from "../../shared/design-system/ui/SidebarNavigation";
import { NavigationSection } from "../../shared/design-system/ui/NavigationSection";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { PinIcon } from "../../shared/design-system/icons";
import styles from "./RailNavigation.module.css";

export function RailPinPicker({
  open,
  onOpenChange,
  query,
  onQuery,
  error,
  current,
  matches,
  pinned,
  artwork,
  onPin,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  query: string;
  onQuery(query: string): void;
  error: string | undefined;
  current: RailEntry;
  matches: readonly RailEntry[];
  pinned: ReadonlySet<string>;
  artwork(entry: RailEntry): ReactNode;
  onPin(entry: RailEntry): void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add a pin"
      description="Keep a chat, person, channel, agent, or page close by."
      height="stable"
    >
      <div className={styles.picker}>
        {error && (
          <p role="alert" className={styles.note}>
            {error}
          </p>
        )}
        <Input
          aria-label="Find something to pin"
          placeholder="Search chats, people, channels…"
          value={query}
          onChange={(event) => onQuery(event.currentTarget.value)}
          autoFocus
        />
        <SidebarNavigation>
          {!query && (
            <NavigationSection label="Current view">
              <NavigationItem
                label={`Pin ${current.label}`}
                icon={<PinIcon size={18} />}
                disabled={pinned.has(current.id)}
                onClick={() => {
                  onPin(current);
                }}
              />
            </NavigationSection>
          )}
          <NavigationSection label="Destinations">
            {matches.map((entry) => (
              <NavigationItem
                key={entry.id}
                icon={artwork(entry)}
                label={entry.label}
                aria-label={`Pin ${entry.target.kind === "person" ? "person " : ""}${entry.label}`}
                disabled={pinned.has(entry.id)}
                trailing={
                  pinned.has(entry.id)
                    ? "Pinned"
                    : entry.target.kind === "person"
                      ? "Person"
                      : entry.kind === "person"
                        ? "Message"
                        : entry.kind
                }
                onClick={() => {
                  onPin(entry);
                }}
              />
            ))}
            {!matches.length && (
              <p className={styles.note}>No matches in this community.</p>
            )}
          </NavigationSection>
        </SidebarNavigation>
      </div>
    </Dialog>
  );
}
