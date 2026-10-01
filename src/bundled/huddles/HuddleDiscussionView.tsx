import { useEffect, useRef, useState, type ReactNode } from "react";
import type { HuddleDiscussion } from "../../features/huddle/discussion";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { Button } from "../../shared/design-system/ui/Button";

import styles from "./HuddleDiscussion.module.css";

export function HuddleDiscussionView({
  discussion,
  composer,
  older,
  retry,
  recover,
}: {
  discussion: HuddleDiscussion;
  composer: ReactNode;
  older(): void;
  retry(): void;
  recover(id: string, dismiss?: boolean): void;
}) {
  const [tab, setTab] = useState<"thread" | "transcript">("thread");
  const tail = useRef<HTMLDivElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const composerHost = useRef<HTMLDivElement>(null);
  const focusConversation = () => {
    const editor = composerHost.current?.querySelector<HTMLElement>(
      '[role="textbox"]:not([aria-disabled="true"]), textarea:not(:disabled)',
    );
    (editor ?? log.current)?.focus({ preventScroll: true });
  };
  const following = useRef(true);
  const newest = discussion.rows.at(-1)?.id;
  useEffect(() => {
    if (newest && tab === "thread" && following.current)
      tail.current?.scrollIntoView({ block: "end" });
  }, [newest, tab]);
  return (
    <div className={styles.discussion}>
      <Tabs
        label="Huddle conversation"
        variant="panel"
        value={tab}
        onValueChange={setTab}
        items={[
          { value: "thread", label: "Thread" },
          { value: "transcript", label: "Live transcript" },
        ]}
        renderPanel={(selected) =>
          selected === "transcript" ? (
            <div className={styles.empty}>
              <p>Live transcript</p>
              <p className="text-secondary">
                Speech transcription isn’t connected in this version yet.
              </p>
            </div>
          ) : (
            <div className={styles.thread}>
              <div
                ref={log}
                tabIndex={-1}
                className={styles.messages}
                role="log"
                aria-label="Huddle messages"
                onScroll={(e) => {
                  const el = e.currentTarget;
                  following.current =
                    el.scrollHeight - el.scrollTop - el.clientHeight < 48;
                }}
              >
                {discussion.historyLimited && (
                  <p className={styles.notice}>
                    Showing the latest 200 messages.
                  </p>
                )}
                {discussion.hasMore && (
                  <Button size="sm" onClick={older}>
                    Load earlier messages
                  </Button>
                )}
                {!discussion.rows.length && (
                  <p className={styles.empty}>
                    {discussion.status === "loading"
                      ? "Loading conversation…"
                      : "Start the conversation."}
                  </p>
                )}
                {discussion.rows.map((row) => (
                  <article key={row.id} className={styles.message}>
                    <div className={styles.avatar}>
                      {row.picture ? (
                        <img src={row.picture} alt="" />
                      ) : (
                        row.author.slice(0, 1)
                      )}
                    </div>
                    <div>
                      <header>
                        <strong>{row.author}</strong>
                        <time
                          dateTime={new Date(row.time * 1000).toISOString()}
                        >
                          {new Date(row.time * 1000).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </time>
                      </header>
                      <p>{row.text}</p>
                      {["failed", "unknown"].includes(row.delivery) && (
                        <p role="status" className="text-secondary">
                          {row.delivery === "unknown"
                            ? "Delivery hasn’t been confirmed. Retry sends the same message."
                            : "Message wasn’t delivered."}{" "}
                          <Button
                            size="sm"
                            disabled={!discussion.writable}
                            onClick={() => {
                              focusConversation();
                              recover(row.id);
                            }}
                          >
                            Retry
                          </Button>{" "}
                          <Button
                            size="sm"
                            onClick={() => {
                              focusConversation();
                              recover(row.id, true);
                            }}
                          >
                            Discard
                          </Button>
                        </p>
                      )}
                    </div>
                  </article>
                ))}
                <div ref={tail} />
              </div>
              {discussion.error && (
                <div role="alert" className={styles.notice}>
                  {discussion.error}{" "}
                  <Button
                    size="sm"
                    onClick={() => {
                      log.current?.focus({ preventScroll: true });
                      retry();
                    }}
                  >
                    Retry
                  </Button>
                </div>
              )}
              {discussion.writable ? (
                <div ref={composerHost} className={styles.composer}>
                  {composer}
                </div>
              ) : (
                discussion.status === "ready" && (
                  <p className={styles.notice}>
                    This Huddle conversation is read-only.
                  </p>
                )
              )}
            </div>
          )
        }
      />
    </div>
  );
}
