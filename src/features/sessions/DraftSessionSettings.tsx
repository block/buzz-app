import { InlineHeader } from "../../shared/design-system/ui/Header";
import { ChannelDurationField } from "../../bundled/channels/ChannelDurationField";
import { detailsDraftErrors } from "../relay/channel-details-protocol";
import { DEFAULT_TEMPORARY_CHANNEL_TTL_SECONDS } from "../relay/work-sessions";
import { useEffect, useState } from "react";
import type { RelaySession } from "../relay/session";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import styles from "./WorkspaceSettings.module.css";
import { WorkspaceFields } from "./WorkspaceFields";
import {
  emptyWorkspace,
  loadSessionSetup,
  readWorkspace,
  workspaceCanvas,
} from "./workspace";

/** Edits only the local draft; first-send owns remote setup and its retry receipt. */
export function DraftSessionSettings({
  session,
  sectionId,
  personal = false,
  canvas,
  save,
  close,
  ttlSeconds,
  parentLinked = false,
}: {
  session: RelaySession;
  sectionId?: string | undefined;
  personal?: boolean;
  canvas?: string | undefined;
  ttlSeconds?: number | undefined;
  parentLinked?: boolean;
  save(canvas: string, ttlSeconds?: number): void;
  close(): void;
}) {
  const [ttl, setTtl] = useState(ttlSeconds);
  const [temporaryTtl, setTemporaryTtl] = useState(
    ttlSeconds ?? DEFAULT_TEMPORARY_CHANNEL_TTL_SECONDS,
  );
  const lifetimeError = detailsDraftErrors({
    name: "Session",
    description: "",
    visibility: "private",
    ttlSeconds: ttl,
  }).lifetime;
  const [workspace, setWorkspace] = useState(emptyWorkspace);
  const [raw, setRaw] = useState<string>();
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly retries a failed settings read.
  useEffect(() => {
    let active = true;
    setError("");
    void (async () => {
      try {
        const content =
          canvas ??
          (sectionId
            ? (await loadSessionSetup(session, sectionId, personal)).canvas
            : "");
        if (!active) return;
        try {
          setWorkspace(readWorkspace(content));
        } catch {
          setRaw(content);
        }
        setLoaded(true);
      } catch (reason) {
        if (active)
          setError(reason instanceof Error ? reason.message : String(reason));
      }
    })();
    return () => {
      active = false;
    };
  }, [session, sectionId, personal, canvas, attempt]);
  return (
    <Dialog
      open
      height="stable"
      footerGap="roomy"
      title="Session settings"
      onOpenChange={(open) => {
        if (!open) close();
      }}
      actions={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="prominent"
            disabled={!loaded || (!parentLinked && !!lifetimeError)}
            onClick={() => {
              try {
                save(
                  raw === undefined
                    ? workspaceCanvas(workspace)
                    : workspaceCanvas({ folders: [], canvas: raw }),
                  parentLinked ? undefined : ttl,
                );
                close();
              } catch (reason) {
                setError(
                  reason instanceof Error ? reason.message : String(reason),
                );
              }
            }}
          >
            Save changes
          </Button>
        </>
      }
    >
      <div className={styles.fields}>
        {loaded ? (
          raw === undefined ? (
            <WorkspaceFields value={workspace} onChange={setWorkspace} />
          ) : (
            <Field label="Canvas">
              <Textarea
                rows={12}
                value={raw}
                onChange={(event) => setRaw(event.target.value)}
              />
            </Field>
          )
        ) : (
          !error && <p role="status">Loading settings…</p>
        )}
        {!parentLinked && (
          <>
            <InlineHeader title="Lifetime" />
            <ChannelDurationField
              temporary={ttl !== undefined}
              ttlSeconds={temporaryTtl}
              disabled={!loaded}
              error={lifetimeError}
              onChange={(next) => {
                setTtl(next);
                if (next !== undefined) setTemporaryTtl(next);
              }}
            />
          </>
        )}
        {error && <p role="alert">{error}</p>}
        {!loaded && error && (
          <Button onClick={() => setAttempt((value) => value + 1)}>
            Retry settings
          </Button>
        )}
      </div>
    </Dialog>
  );
}
