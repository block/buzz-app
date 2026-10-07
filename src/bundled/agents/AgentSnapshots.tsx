import { useEffect, useRef, useState } from "react";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Button } from "../../shared/design-system/ui/Button";
import type { AgentControl, AgentView } from "../../features/agents/control";
import type { RelaySession } from "../../features/relay/session";
import { relayOrigin } from "../../features/communities/destination";
import { uploadAvatar } from "../../features/profiles/avatar-upload";
import {
  buildAgentSnapshot,
  encodeAgentSnapshot,
  parseAgentSnapshot,
  type AgentSnapshot,
  type MemoryLevel,
} from "../../features/agents/snapshot";

function download(bytes: Uint8Array, name: string, mime: string) {
  const url = URL.createObjectURL(
    new Blob([Uint8Array.from(bytes)], { type: mime }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function AgentSnapshotExport({
  agent,
  session,
  destination,
  onClose,
}: {
  agent: AgentView;
  session?: RelaySession | undefined;
  destination: string;
  onClose(): void;
}) {
  const [level, setLevel] = useState<MemoryLevel>("none");
  const [format, setFormat] = useState<"json" | "png">("png");
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const exportFile = async () => {
    if (pending || (level !== "none" && !confirmed)) return;
    setPending(true);
    setError("");
    try {
      let entries: { slug: string; body: string }[] = [];
      if (level !== "none") {
        if (
          !session ||
          relayOrigin(agent.relayUrl) !== relayOrigin(destination)
        )
          throw new Error("Memory reads require the source agent's community.");
        const view = session.agentMemories.open(agent.pubkey);
        try {
          await view.refresh();
          const state = view.snapshot();
          if (
            state.status !== "ready" ||
            !state.listing ||
            state.listing.partial
          )
            throw new Error(
              "Couldn’t load complete memories. Check your connection and try again.",
            );
          entries = state.listing.entries.map(({ slug, body }) => ({
            slug,
            body,
          }));
        } finally {
          view.dispose();
        }
      }
      const snapshot = buildAgentSnapshot(agent, level, entries);
      const bytes = encodeAgentSnapshot(snapshot, format);
      download(
        bytes,
        `${agent.name.replace(/[^a-zA-Z0-9_-]+/g, "-")}.agent.${format}`,
        format === "png" ? "image/png" : "application/json",
      );
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Export failed.");
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
      preventClose={pending}
      title={`Export ${agent.name}`}
      actions={
        <>
          <Button disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={pending || (level !== "none" && !confirmed)}
            onClick={() => void exportFile()}
          >
            Export
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <label className="flex items-center gap-2">
          Memories
          <select
            aria-label="Memories"
            value={level}
            disabled={
              pending ||
              !session ||
              !destination ||
              relayOrigin(agent.relayUrl) !== relayOrigin(destination)
            }
            onChange={(event) => {
              setConfirmed(false);
              setLevel(event.target.value as MemoryLevel);
            }}
          >
            <option value="none">Agent only</option>
            <option value="core">Agent + core memory</option>
            <option value="everything">Agent + all memories</option>
          </select>
        </label>
        <label className="flex items-center gap-2">
          File format
          <select
            aria-label="File format"
            value={format}
            disabled={pending}
            onChange={(event) =>
              setFormat(event.target.value as "json" | "png")
            }
          >
            <option value="png">PNG</option>
            <option value="json">JSON</option>
          </select>
        </label>
        {level !== "none" && (
          <>
            <p role="alert">
              Memory is stored as <strong>plaintext</strong> in the snapshot.
              Only share it with people you trust.
            </p>
            <p>
              {level === "core"
                ? "Core memory"
                : "Core memory and all mem/* entries"}{" "}
              will be included.
            </p>
            <label>
              <input
                type="checkbox"
                checked={confirmed}
                disabled={pending}
                onChange={(event) => setConfirmed(event.target.checked)}
              />{" "}
              I confirm that I want to include memory in this snapshot.
            </label>
          </>
        )}
        {error && <p role="alert">{error}</p>}
      </div>
    </Dialog>
  );
}

export function AgentSnapshotImport({
  control,
  destination,
  owner,
  receivedBytes,
  onClose,
}: {
  control: AgentControl;
  destination: string;
  owner: string;
  /** Received attachment bytes are previewed only; importing still requires an explicit click. */
  receivedBytes?: Uint8Array;
  onClose(): void;
}) {
  const requestId = useRef(crypto.randomUUID());
  const [snapshot, setSnapshot] = useState<AgentSnapshot>();
  const [fileError, setFileError] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  const [createdId, setCreatedId] = useState<string>();
  const [profilePublished, setProfilePublished] = useState(false);
  useEffect(() => {
    if (!receivedBytes) return;
    requestId.current = crypto.randomUUID();
    try {
      setSnapshot(parseAgentSnapshot(receivedBytes));
      setFileError("");
    } catch (error) {
      setSnapshot(undefined);
      setFileError(
        error instanceof Error ? error.message : "Invalid snapshot JSON.",
      );
    }
  }, [receivedBytes]);
  const read = async (file?: File) => {
    setFileError("");
    setSnapshot(undefined);
    const readId = crypto.randomUUID();
    requestId.current = readId;
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) {
      setFileError("Snapshot exceeds the size limit.");
      return;
    }
    try {
      const parsed = parseAgentSnapshot(
        new Uint8Array(await file.arrayBuffer()),
      );
      if (requestId.current === readId) setSnapshot(parsed);
    } catch (error) {
      if (requestId.current !== readId) return;
      setFileError(
        error instanceof Error ? error.message : "Invalid snapshot JSON.",
      );
    }
  };
  const create = async () => {
    if (
      createdId ||
      !snapshot ||
      busy ||
      !control.create ||
      !destination ||
      !owner ||
      (snapshot.memory.entries.length > 0 && !control.writeSnapshotMemory)
    )
      return;
    setBusy(true);
    setFileError("");
    try {
      const selected = control
        .snapshot()
        .data?.harnessOptions?.find(
          (option) =>
            option.available !== false && option.command === "buzz-agent",
        );
      if (!selected)
        throw new Error(
          "Buzz Agent is unavailable. Install it in Settings first.",
        );
      let picture = snapshot.profile.avatarUrl;
      if (snapshot.profile.avatarDataUrl) {
        const [header, encoded] = snapshot.profile.avatarDataUrl.split(",", 2);
        const mime = header?.slice("data:".length).split(";", 1)[0];
        if (!encoded || !mime)
          throw new Error("Snapshot avatar data is malformed.");
        const raw = atob(encoded);
        const bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0));
        picture = await uploadAvatar(
          new File([bytes], "snapshot-avatar", { type: mime }),
          destination,
          new AbortController().signal,
        );
      }
      const agent = await control.create(
        requestId.current,
        destination,
        owner,
        {
          name: snapshot.profile.displayName,
          systemPrompt: snapshot.definition.systemPrompt ?? "",
          sessionPolicy: snapshot.definition.sessionPolicy ?? "thread",
          workspace: control.snapshot().data?.defaultWorkspace ?? "",
          harness: {
            command: "buzz-agent",
            args: selected.defaultArgs ?? [],
            model: snapshot.definition.model ?? "",
            provider: snapshot.definition.provider ?? "",
            databricks: null,
          },
          environment: {},
          ...(picture ? { picture } : {}),
        },
      );
      setCreatedId(agent.id);
      setResult(
        `${agent.name} was created successfully. Review settings and configure local credentials in Edit, publish its profile, then Start the agent.`,
      );
      if (snapshot.memory.entries.length && control.writeSnapshotMemory) {
        try {
          const outcome = await control.writeSnapshotMemory(
            agent.id,
            snapshot.memory.entries,
          );
          if (outcome.written !== snapshot.memory.entries.length)
            setFileError(
              `Memory partially restored: ${outcome.written} of ${snapshot.memory.entries.length} entries written. The agent exists but some memory entries failed to publish. ${outcome.errors.join("; ")}`,
            );
        } catch (error) {
          setFileError(
            `Memory partially restored: 0 of ${snapshot.memory.entries.length} entries written. The agent exists but publication was not confirmed. Check its memories before retrying. ${error instanceof Error ? error.message : ""}`,
          );
        }
      }
    } catch (error) {
      await control.refresh();
      setFileError(
        `${error instanceof Error ? error.message : "Import failed."} Check Agents before retrying to avoid a duplicate identity.`,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      preventClose={busy}
      title={result ? "Agent imported" : "Import agent snapshot"}
      actions={
        result ? (
          <Button disabled={busy} onClick={onClose}>
            Close
          </Button>
        ) : (
          <>
            <Button
              disabled={
                busy ||
                !!createdId ||
                !snapshot ||
                !destination ||
                !owner ||
                (snapshot.memory.entries.length > 0 &&
                  !control.writeSnapshotMemory)
              }
              variant="primary"
              onClick={() => void create()}
            >
              Import
            </Button>
            <Button disabled={busy} onClick={onClose}>
              Cancel
            </Button>
          </>
        )
      }
    >
      {result ? (
        <>
          <p>{result}</p>
          {createdId && control.publishProfile && !profilePublished && (
            <Button
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void control
                  .publishProfile?.(createdId)
                  .then(
                    () => {
                      setProfilePublished(true);
                      setFileError("Profile published.");
                    },
                    () =>
                      setFileError(
                        "Profile publication unconfirmed. Review agent status and retry from Manage.",
                      ),
                  )
                  .finally(() => setBusy(false));
              }}
            >
              Publish profile
            </Button>
          )}
          {fileError && <p role="alert">{fileError}</p>}
        </>
      ) : (
        <div className="space-y-4">
          {!receivedBytes && (
            <input
              type="file"
              disabled={busy}
              accept=".json,.png,.agent.json,.agent.png,application/json,image/png"
              aria-label="Agent snapshot"
              onChange={(event) => void read(event.target.files?.[0])}
            />
          )}
          {snapshot && (
            <>
              <h3>{snapshot.profile.displayName}</h3>
              <section>
                <p>Agent instructions</p>
                <p>
                  Review the instructions this agent will follow after import.
                </p>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words">
                  {snapshot.definition.systemPrompt ||
                    "No system prompt included."}
                </pre>
              </section>
              <p>
                A new agent will be created with a fresh keypair. The imported
                agent is independent of the source — identity never travels.
              </p>
              {snapshot.memory.entries.length ? (
                <p role="alert">
                  This snapshot includes{" "}
                  <strong>
                    {snapshot.memory.entries.length}{" "}
                    {snapshot.memory.level === "core" ? "core" : "all"} memory{" "}
                    {snapshot.memory.entries.length === 1 ? "entry" : "entries"}
                  </strong>
                  . Memory is stored as plaintext in the file and will be
                  restored under the new agent's identity.
                </p>
              ) : (
                <p>No memory included — config only.</p>
              )}
              {snapshot.memory.entries.length > 0 &&
                !control.writeSnapshotMemory && (
                  <p role="alert">
                    Memory restoration requires a packaged desktop with snapshot
                    memory support. Import is disabled to prevent dropping
                    entries.
                  </p>
                )}
              <p>
                Review imported model and harness settings in Edit. Local
                provider credentials and environment overrides must be
                configured on this device.
              </p>
              <details>
                <summary>Full embedded manifest</summary>
                <p>
                  This is the complete portable payload decoded from the file.
                  Secrets, credentials, and source identity are not part of the
                  snapshot format.
                </p>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words">
                  {JSON.stringify(snapshot, null, 2)}
                </pre>
              </details>
            </>
          )}
          {busy && <p role="status">Creating agent…</p>}
          {fileError && <p role="alert">{fileError}</p>}
        </div>
      )}
    </Dialog>
  );
}
