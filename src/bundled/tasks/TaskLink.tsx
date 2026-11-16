// A task's link in a message: the task's live status and title in place of
// the link, and a hover card with its details. Someone who can't see the task
// sees only that it isn't available, never its title.
import { useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import {
  LinkInteractiveContext,
  LinkLabelContext,
  LinkPreviewContext,
} from "../../features/conversation/LinkLabelContext";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { Button } from "../../shared/design-system/ui/Button";
import { LinkLabel } from "../links/InlineLink";
import { statusLabels, type Task } from "./model";
import { projectOf } from "./places";
import { usePlaces, useTasks } from "./react";
import { taskLinkId } from "./route";
import { StatusIcon } from "./StatusIcon";
import styles from "./Tasks.module.css";

export function TaskLink({ url, relay }: { url: string; relay: RelayData }) {
  const live = useContext(LinkInteractiveContext);
  const connection = useSyncExternalStore(relay.subscribe, relay.snapshot);
  const session =
    live && connection.status === "ready" ? connection.session : undefined;
  const state = useTasks(session);
  const id = taskLinkId(url);
  const task = state.tasks.find((item) => item.id === id);
  const unavailable = !!session && state.status !== "loading" && !task;
  const offer = useContext(LinkPreviewContext);
  const preview = useMemo(
    () =>
      session && (task || unavailable)
        ? {
            label: task ? `Task: ${task.title}` : "Unavailable task",
            render: (open: (target: string) => boolean) =>
              task ? (
                <TaskPreview
                  session={session}
                  task={task}
                  onOpen={() => open(url)}
                />
              ) : (
                <p className="text-body-sm m-0">
                  This task isn’t available. You may not have access, or it may
                  have been deleted.
                </p>
              ),
          }
        : undefined,
    [session, task, unavailable, url],
  );
  useEffect(() => {
    if (!offer || !preview) return;
    offer(preview);
    return () => offer(undefined);
  }, [offer, preview]);
  // An authored label stays; a pasted link takes the task's title.
  const authored = useContext(LinkLabelContext) !== undefined;
  return (
    <LinkLabel
      href={url}
      {...(!authored && { label: task?.title || "Task" })}
      {...(task && {
        icon: (
          <span className={styles.linkIcon}>
            <StatusIcon status={task.status} />
          </span>
        ),
      })}
    />
  );
}

function TaskPreview({
  session,
  task,
  onOpen,
}: {
  session: RelaySession;
  task: Task;
  onOpen(): void;
}) {
  const places = usePlaces(session, [task.home]);
  const project = projectOf(task, places);
  const where = project.name ?? places.get(task.home)?.name;
  return (
    <div className={styles.preview}>
      <strong className="text-label">{task.title}</strong>
      <span className="text-body-sm text-subtle">
        <StatusIcon status={task.status} /> {statusLabels[task.status]}
        {where ? ` · ${where}` : ""}
      </span>
      <div>
        <Button size="sm" onClick={onOpen}>
          Open task
        </Button>
      </div>
    </div>
  );
}
