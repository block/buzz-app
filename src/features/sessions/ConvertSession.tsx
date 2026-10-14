import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ComponentProps } from "react";
import type { RelaySession } from "../relay/session";
import type { ChannelSummary } from "../relay/contracts";
import {
  sameLabels,
  type ChannelDetails,
} from "../relay/channel-details-protocol";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Radio, RadioGroup } from "../../shared/design-system/ui/RadioGroup";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { sessionShareAttempt, useSessionShareAttempts } from "./share-attempt";
import { sessionMetadata } from "./metadata";
import { applySharedChannelDetails } from "./share";

/** Presentation gating only; fresh signed details authorize the actual write. */
export function canConvertSession(
  session: RelaySession,
  channel?: ChannelSummary,
) {
  return !!(
    session.channelDetails?.available &&
    channel &&
    channel.channelType === "session" &&
    !channel.parentChannelId &&
    !channel.cached &&
    !channel.readOnly &&
    !channel.archived
  );
}

/** Conversion changes the marker and chosen visibility, not membership, TTL or Me. */
export function ConvertSession({
  session,
  id,
  signal,
  close,
  finalFocus,
}: {
  session: RelaySession;
  id: string;
  signal?: AbortSignal | undefined;
  close(): void;
  finalFocus?: ComponentProps<typeof Dialog>["finalFocus"];
}) {
  const details = session.channelDetails;
  const sharing = useSessionShareAttempts(session).has(id);
  const notify = useToastNotification();
  const attempt = useSyncExternalStore(details.subscribe, () =>
    details.snapshot(id),
  );
  const [base, setBase] = useState<ChannelDetails>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const lifetime = useRef<AbortController | undefined>(undefined);
  const pending = useRef(false);
  const metadata = base && sessionMetadata(base.description);
  const conversionAttempt =
    attempt?.draft.description === "" ? attempt : undefined;
  const matchingAttempt = !!(
    base &&
    conversionAttempt &&
    conversionAttempt.draft.name === base.name &&
    conversionAttempt.draft.ttlSeconds === base.ttlSeconds &&
    (conversionAttempt.draft.labels === undefined ||
      sameLabels(conversionAttempt.draft.labels, base.labels ?? [])) &&
    (base.description === "" || (metadata && !metadata.parentId))
  );
  const eligible = !!base?.canEdit && !!metadata && !metadata.parentId;
  // Uncertain intent belongs to the details owner, including the chosen privacy.
  const selectedVisibility = conversionAttempt?.draft.visibility ?? visibility;

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    const active = AbortSignal.any([
      controller.signal,
      ...(signal ? [signal] : []),
    ]);
    setBase(undefined);
    setVisibility("private");
    setError("");
    setBusy(false);
    pending.current = false;
    void details
      .load(id, active)
      .then((next) => {
        if (!active.aborted) setBase(next);
      })
      .catch((reason) => {
        if (!active.aborted)
          setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => controller.abort();
  }, [details, id, signal]);

  const run = async (action: "convert" | "reload" | "check") => {
    const controller = lifetime.current;
    if (
      !controller ||
      controller.signal.aborted ||
      signal?.aborted ||
      pending.current
    )
      return;
    const active = AbortSignal.any([
      controller.signal,
      ...(signal ? [signal] : []),
    ]);
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      if (action === "reload") {
        const next = await details.load(id, active);
        if (!active.aborted) setBase(next);
      } else {
        if (
          !base ||
          (action === "check"
            ? !matchingAttempt || attempt?.status !== "unconfirmed"
            : !eligible || !!attempt)
        )
          return;
        if (action === "convert" && sessionShareAttempt(session, id))
          throw new Error(
            "Finish sharing or choose Start over before converting.",
          );
        if (action === "check") await details.check(id, active);
        else
          await applySharedChannelDetails(
            session,
            id,
            {
              name: base.name,
              description: "",
              visibility,
              ttlSeconds: base.ttlSeconds,
            },
            base,
            active,
          );
        if (!active.aborted) {
          notify("Now a channel. Find it in Messages.", "success");
          close();
        }
      }
    } catch (reason) {
      if (!active.aborted)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (!controller.signal.aborted) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  return (
    <Dialog
      open
      title="Convert to channel"
      description="The same conversation appears in Messages and stays in Me. History, Canvas and members stay the same."
      onOpenChange={(open) => {
        if (!open) close();
      }}
      preventClose={busy}
      finalFocus={finalFocus}
      actions={
        <>
          <Button onClick={close} disabled={busy}>
            Cancel
          </Button>
          {attempt?.status === "unconfirmed" && matchingAttempt ? (
            <Button
              disabled={busy || !!signal?.aborted}
              onClick={() => void run("check")}
            >
              Check status
            </Button>
          ) : (
            <Button
              variant="prominent"
              disabled={
                busy || sharing || !!attempt || !eligible || !!signal?.aborted
              }
              onClick={() => void run("convert")}
            >
              Convert to channel
            </Button>
          )}
        </>
      }
    >
      <Field label="Visibility" nativeLabel={false}>
        <RadioGroup
          aria-label="Visibility"
          value={selectedVisibility}
          disabled={
            busy || sharing || !!attempt || !eligible || !!signal?.aborted
          }
          onValueChange={(value) => {
            if (value === "private" || value === "public") setVisibility(value);
          }}
        >
          <Radio
            value="private"
            label="Private"
            description="Only channel members will have access."
          />
          <Radio
            value="public"
            label="Public"
            description="Everyone in this community will be able to view this channel’s full history."
          />
        </RadioGroup>
      </Field>
      {sharing && (
        <p role="status">
          Finish sharing or choose Start over before converting.
        </p>
      )}
      {!base && !error && <p role="status">Loading session details…</p>}
      {base && !base.canEdit && (
        <p role="status">You don’t have permission to convert this session.</p>
      )}
      {base?.canEdit && !eligible && !matchingAttempt && (
        <p role="status">Only a standalone session can be converted.</p>
      )}
      {attempt && !matchingAttempt && (
        <p role="status">
          Finish the existing channel details change before converting.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {error && (
        <Button
          disabled={busy || !!signal?.aborted}
          onClick={() => void run("reload")}
        >
          Reload session details
        </Button>
      )}
    </Dialog>
  );
}
