import type { RelaySession } from "../../features/relay/session";
import type { useSoloForkLock } from "../../features/solo/useSoloForkLock";
import { Accordion } from "../../shared/design-system/ui/Accordion";
import { Button } from "../../shared/design-system/ui/Button";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import styles from "./SoloForkPreview.module.css";

/** Read-only historical text. No parent timeline, actions, read marks or navigation ownership. */
export function SoloForkPreview({
  session,
  state,
}: {
  session: RelaySession;
  state: ReturnType<typeof useSoloForkLock>;
}) {
  if (!state.pending && !state.reason && !state.seed) return null;
  const seed = state.seed;
  const source = seed && session.channels.get?.(seed.fork.channelId);
  return (
    <div className={styles.preview}>
      {state.createEventId && (
        <p className={`text-caption text-subtle ${styles.body}`}>
          Retained create event ID: {state.createEventId}
        </p>
      )}
      <LoadingRegion
        pending={state.pending}
        label="Confirming chat context…"
        feedback={
          !state.pending && state.reason ? (
            <div role="alert">
              <p>{state.reason}</p>
              <Button onClick={state.retry}>Retry context</Button>
            </div>
          ) : undefined
        }
      >
        {seed && (
          <Accordion
            variant="section"
            items={[
              {
                value: "inherited",
                title: `Forked from ${source?.name ?? seed.fork.channelId.slice(0, 8)} · current seed preview`,
                content: (
                  <>
                    <p className="text-caption text-subtle">
                      Up to 12 messages total. New chat messages take priority.
                      This is live source content, not a record of what an
                      earlier turn received.
                    </p>
                    <section
                      className={styles.history}
                      aria-label="Inherited current seed preview"
                      // biome-ignore lint/a11y/noNoninteractiveTabindex: The scroll owner must support keyboard panning.
                      tabIndex={0}
                    >
                      {seed.inherited.length ? (
                        seed.inherited.map((row) => (
                          <div key={row.id} className={styles.message}>
                            <p className="text-label-sm">
                              {session.names.resolve(row.authorId) ??
                                row.authorId.slice(0, 8)}
                            </p>
                            <p className={styles.body}>{row.content}</p>
                          </div>
                        ))
                      ) : (
                        <p>
                          No inherited messages in the current twelve-message
                          seed.
                        </p>
                      )}
                    </section>
                    <Button onClick={state.retry}>
                      Refresh current seed preview
                    </Button>
                  </>
                ),
              },
            ]}
          />
        )}
      </LoadingRegion>
    </div>
  );
}
