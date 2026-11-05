import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { noteKey, noteUrl, type Note } from "../../features/notes/model";
import {
  ArrowLeftIcon,
  ArrowsClockwiseIcon,
  Filter2Icon,
  InfoIcon,
  FileIcon,
  PlusIcon,
} from "../../shared/design-system/icons";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Panel } from "../../shared/design-system/ui/Panel";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
  PopoverTitle,
  PopoverDescription,
} from "../../shared/design-system/ui/Popover";
import { SearchField } from "../../shared/design-system/ui/SearchField";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuCheckboxItem,
} from "../../shared/design-system/ui/Menu";
import { NoteTime } from "./NoteMetadata";
import styles from "./NotesPage.module.css";

export type NotesPageProps = {
  community: string;
  entries: readonly Note[];
  items: readonly { id: string; label: string; content: ReactNode }[];
  selected: string;
  query: string;
  trash: boolean;
  canFilter: boolean;
  searchRef: RefObject<HTMLElement | null>;
  loading: boolean;
  more: boolean;
  error: string;
  search(query: string, commit?: boolean): void;
  showDeleted(value: boolean): void;
  create(): void;
  refresh(): void;
  loadMore(): void;
  open(note: Note): void;
  browse(): void;
};

/** The workspace owns discovery, access, drafts and navigation. This page renders its documents. */
export function NotesPage({
  community,
  entries,
  items,
  selected,
  query,
  trash,
  canFilter,
  searchRef,
  loading,
  more,
  error,
  search,
  showDeleted,
  create,
  refresh,
  loadMore,
  open,
  browse,
}: NotesPageProps) {
  const backRef = useRef<HTMLButtonElement>(null);
  const reading = selected !== "browse";
  useEffect(() => {
    if (selected !== "browse" && !selected.startsWith("new:"))
      backRef.current?.focus();
  }, [selected]);
  const match = query.toLowerCase();
  const visible = entries
    .filter((note) =>
      `${note.title}\n${note.markdown}\n${note.event.pubkey}`
        .toLowerCase()
        .includes(match),
    )
    .sort(
      (a, b) =>
        b.event.created_at - a.event.created_at ||
        a.event.id.localeCompare(b.event.id),
    );
  const empty = !loading && !error && !entries.length && !query;
  const active = items.find((item) => item.id === selected);
  const titleLink = (note: Note) => (
    <li key={noteKey(note)}>
      <NavigationItem
        nativeButton={false}
        role="link"
        aria-label={note.title}
        render={<a href={noteUrl(note, community)} />}
        label={<span className="text-label">{note.title}</span>}
        icon={<FileIcon size={16} className="text-subtle" aria-hidden="true" />}
        trailing={
          <span className="text-caption text-subtle">
            <NoteTime note={note.event} />
          </span>
        }
        onClick={(event) => {
          if (
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          )
            return;
          event.preventDefault();
          open(note);
        }}
      />
    </li>
  );
  return (
    <div className={styles.page}>
      <div className={styles.collection} hidden={reading}>
        <Panel aria-label="Pages">
          <div className={styles.page}>
            <PanelHeader
              title={
                <PanelHeaderLabel title="Pages" icon={<FileIcon size={16} />}>
                  <PopoverRoot>
                    <PopoverTrigger
                      render={
                        <IconButton
                          aria-label="About pages"
                          title="About pages"
                          icon={<InfoIcon size={16} />}
                        />
                      }
                    />
                    <PopoverPopup>
                      <PopoverTitle>About pages</PopoverTitle>
                      <PopoverDescription
                        render={<div className={styles.description} />}
                      >
                        <p>
                          Create pages with people and agents. Open a title to
                          read or edit the page, then use Back to pages to
                          return to the list.
                        </p>
                        <p>
                          Each page has its own sharing settings. Access
                          includes retained revisions. The relay operator can
                          read page contents. Don’t include secrets.
                        </p>
                      </PopoverDescription>
                    </PopoverPopup>
                  </PopoverRoot>
                </PanelHeaderLabel>
              }
              actions={
                <IconButton
                  aria-label="Refresh pages"
                  title="Refresh pages"
                  icon={
                    <ArrowsClockwiseIcon
                      size={16}
                      className={
                        loading ? "motion-safe:animate-spin" : undefined
                      }
                    />
                  }
                  aria-busy={loading}
                  disabled={loading}
                  onClick={refresh}
                />
              }
            />
            <div className={styles.body}>
              <SearchField
                variant="capsule"
                inputRef={searchRef}
                label="Search pages"
                disabled={!entries.length && !query}
                placeholder="Search"
                value={query}
                onValueChange={(value) => search(value)}
                onBlur={() => search(query, true)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") search(query, true);
                }}
                trailing={
                  <MenuRoot>
                    <MenuTrigger
                      disabled={!canFilter}
                      render={
                        <IconButton
                          aria-label="Filter pages"
                          title="Filter pages"
                          variant={trash ? "prominent" : "ghost"}
                          icon={<Filter2Icon size={16} aria-hidden="true" />}
                        />
                      }
                    />
                    <MenuPopup align="end">
                      <MenuCheckboxItem
                        checked={trash}
                        onCheckedChange={showDeleted}
                        closeOnClick
                      >
                        Show deleted pages
                      </MenuCheckboxItem>
                    </MenuPopup>
                  </MenuRoot>
                }
              />
              {loading && (
                <span role="status" className="sr-only">
                  Reading pages…
                </span>
              )}
              {error && <p role="alert">{error}</p>}
              {empty && (
                <EmptyState
                  icon={null}
                  title="No pages yet"
                  description="Create a page or ask an agent to save one."
                  action={
                    <Button variant="subtle" onClick={create}>
                      <PlusIcon size={16} aria-hidden="true" />
                      New page
                    </Button>
                  }
                />
              )}
              {!empty && (
                <ul className={styles.titleList} aria-label="Pages">
                  {visible.map(titleLink)}
                  <li key="new-page">
                    <NavigationItem
                      variant="text"
                      icon={<PlusIcon size={16} aria-hidden="true" />}
                      label="New page"
                      onClick={create}
                    />
                  </li>
                </ul>
              )}
              {!loading && !error && query && !visible.length && (
                <p role="status">No matching pages.</p>
              )}
              {more && (
                <div>
                  <Button size="sm" loading={loading} onClick={loadMore}>
                    Load more pages
                  </Button>
                </div>
              )}
            </div>
          </div>
        </Panel>
      </div>
      <div className={styles.fullView} hidden={!reading}>
        <Panel aria-label="Page details">
          <PanelHeader
            title={
              <PanelHeaderLabel
                title={active?.label ?? "Page"}
                icon={<FileIcon size={16} />}
              />
            }
            navigation={
              <IconButton
                ref={backRef}
                aria-label="Back to pages"
                title="Back to pages"
                icon={<ArrowLeftIcon size={16} />}
                onClick={browse}
              />
            }
          />
          {items.map((item) => (
            <div
              key={item.id}
              className={styles.noteView}
              hidden={item.id !== selected}
            >
              {item.content}
            </div>
          ))}
        </Panel>
      </div>
    </div>
  );
}
