import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { publicAgentMetadata } from "../../features/agents/public-metadata";
import type {
  EventViewSnapshot,
  RelaySession,
} from "../../features/relay/session";
import { CheckIcon, CopyIcon } from "../../shared/design-system/icons";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import { Button } from "../../shared/design-system/ui/Button";
import styles from "./Profiles.module.css";

const runtimeLabels: Record<string, string> = {
  goose: "Goose",
  "claude-code": "Claude Code",
  "codex-acp": "Codex",
  aider: "Aider",
};
const pending: EventViewSnapshot = { status: "loading", events: [] };
const emptySnapshot = () => pending;
const noSubscribe = () => () => {};

/** Shares the session's bounded views; call after the owner hook so public
 * enrichment cannot consume the last view needed for ownership evidence. */
export function usePublicAgentMetadata(
  session: RelaySession,
  pubkey: string,
  owner: string | undefined,
) {
  const [attempt, retry] = useState(0);
  const [unavailable, setUnavailable] = useState(false);
  const [binding, setBinding] = useState<{
    session: RelaySession;
    pubkey: string;
    owner: string | undefined;
    view: ReturnType<RelaySession["observe"]>;
  }>();
  const view =
    binding?.session === session &&
    binding.pubkey === pubkey &&
    binding.owner === owner
      ? binding.view
      : undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt retries view admission.
  useEffect(() => {
    setUnavailable(false);
    let owned: ReturnType<RelaySession["observe"]>;
    try {
      owned = session.observe([
        { kinds: [10100], authors: [pubkey], limit: 1 },
        ...(owner
          ? [{ kinds: [30177], authors: [owner], "#d": [pubkey], limit: 1 }]
          : []),
      ]);
    } catch {
      setUnavailable(true);
      return;
    }
    setBinding({ session, pubkey, owner, view: owned });
    return owned.dispose;
  }, [session, pubkey, owner, attempt]);
  const snapshot = useSyncExternalStore(
    view?.subscribe ?? noSubscribe,
    view?.snapshot ?? emptySnapshot,
    view?.snapshot ?? emptySnapshot,
  );
  useEffect(() => {
    if (snapshot.status === "idle") void view?.refresh();
  }, [snapshot.status, view]);
  const metadata =
    owner && snapshot.status !== "ready"
      ? undefined
      : publicAgentMetadata(snapshot.events, pubkey, owner);
  return {
    metadata,
    failed: unavailable || snapshot.status === "error",
    retry: () => (view ? void view.refresh() : retry((value) => value + 1)),
  };
}

export function ProfilePublicMetadata({
  source,
  nip05,
}: {
  source: ReturnType<typeof usePublicAgentMetadata>;
  nip05: string | undefined;
}) {
  const { metadata } = source;
  const capabilities = metadata?.capabilities.join(", ");
  return (
    <>
      {source.failed && (
        <div>
          <p role="alert">Could not load this profile.</p>
          <Button size="compact" onClick={source.retry}>
            Retry profile
          </Button>
        </div>
      )}
      {nip05 && (
        <ProfileCopyField
          key={`nip05:${nip05}`}
          label="NIP-05"
          value={nip05}
          unverified
        />
      )}
      {metadata?.agentType && (
        <ProfileCopyField
          key={`type:${metadata.agentType}`}
          label="Agent type"
          value={metadata.agentType}
          display={runtimeLabels[metadata.agentType] ?? metadata.agentType}
        />
      )}
      {!!capabilities && (
        <ProfileCopyField
          key={`capabilities:${capabilities}`}
          label="Capabilities"
          value={capabilities}
        />
      )}
    </>
  );
}

function ProfileCopyField({
  label,
  value,
  display = value,
  unverified = false,
}: {
  label: string;
  value: string;
  display?: string;
  unverified?: boolean;
}) {
  const [feedback, setFeedback] = useState("");
  const [copied, setCopied] = useState(false);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div>
      <button
        tabIndex={0}
        type="button"
        className={styles.copyField}
        aria-label={`Copy ${label}`}
        title={`Copy ${label}`}
        onClick={() => {
          const current = ++generation.current;
          setCopied(false);
          setFeedback("");
          void Promise.resolve()
            .then(() => navigator.clipboard.writeText(value))
            .then(
              () => {
                if (current !== generation.current) return;
                setCopied(true);
                setFeedback(`Copied ${label.toLowerCase()}`);
              },
              () => {
                if (current === generation.current)
                  setFeedback(`Couldn't copy ${label.toLowerCase()}.`);
              },
            );
        }}
      >
        <span className={styles.fieldText}>
          <span className="text-body">{label}</span>
          <span className={styles.fieldValue} title={display}>
            {display}
          </span>
          {unverified && (
            <span className={styles.identifier}>NIP-05 (unverified)</span>
          )}
        </span>
        <span
          className={styles.copyIndicator}
          data-copied={copied}
          aria-hidden="true"
        >
          {copied ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
        </span>
      </button>
      {feedback && (
        <ToastNotice
          title={feedback}
          tone={feedback.startsWith("Copied") ? "success" : "error"}
          timeout={4000}
        />
      )}
    </div>
  );
}
