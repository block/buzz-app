import { useEffect, useRef, useState } from "react";
import type { HuddleDiscussion } from "../../features/huddle/discussion";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { PanelHeader } from "../../shared/design-system/ui/PanelHeader";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import { ChatCircleIcon, XIcon } from "../../shared/design-system/icons";
import styles from "./HuddleDiscussion.module.css";

export function HuddleDiscussionView({
  discussion,
  send,
  close,
  older,
  retry,
  recover,
}: {
  discussion: HuddleDiscussion;
  send(text: string): void;
  close(): void;
  older(): void;
  retry(): void;
  recover(id: string, dismiss?: boolean): void;
}) {
  const [tab, setTab] = useState<"thread" | "transcript">("thread");
  const [draft, setDraft] = useState("");
  const sent = useRef(discussion.sent);
  const tail = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  useEffect(() => {
    if (sent.current !== discussion.sent) {
      setDraft("");
      sent.current = discussion.sent;
    }
  }, [discussion.sent]);
  const newest = discussion.rows.at(-1)?.id;
  useEffect(() => {
    if (newest && tab === "thread" && following.current)
      tail.current?.scrollIntoView({ block: "end" });
  }, [newest, tab]);
  const submit = () => {
    if (draft.trim() && !discussion.sending && discussion.writable) send(draft);
  };
  return (
    <div className={styles.discussion}>
      <PanelHeader
        title="Huddle"
        icon={<ChatCircleIcon size={16} />}
        variant="compact"
        actions={
          <IconButton
            aria-label="Close Huddle chat"
            icon={<XIcon size={16} />}
            onClick={close}
          />
        }
      />
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
                      {row.failed && (
                        <p role="status" className="text-secondary">
                          Message wasn’t delivered.{" "}
                          <Button
                            size="sm"
                            disabled={!discussion.writable}
                            onClick={() => recover(row.id)}
                          >
                            Retry
                          </Button>{" "}
                          <Button
                            size="sm"
                            onClick={() => recover(row.id, true)}
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
                  <Button size="sm" onClick={retry}>
                    Retry
                  </Button>
                </div>
              )}
              {discussion.writable ? (
                <form
                  className={styles.composer}
                  onSubmit={(e) => {
                    e.preventDefault();
                    submit();
                  }}
                >
                  <Field label="Message this Huddle" labelVisibility="hidden">
                    <Textarea
                      value={draft}
                      maxLength={16000}
                      disabled={discussion.sending}
                      placeholder="Message this Huddle"
                      rows={2}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (
                          e.key === "Enter" &&
                          !e.shiftKey &&
                          !e.nativeEvent.isComposing
                        ) {
                          e.preventDefault();
                          submit();
                        }
                      }}
                    />
                  </Field>
                  <Button
                    type="submit"
                    size="sm"
                    disabled={!draft.trim() || discussion.sending}
                  >
                    {discussion.sending ? "Sending…" : "Send"}
                  </Button>
                </form>
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
