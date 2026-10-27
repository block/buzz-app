import { useEffect, useId, useRef, useState } from "react";
import {
  githubPolicy,
  type GithubPolicy,
  type GithubPolicyStatus,
} from "../../../features/agents/github-policy";
import type { Host } from "../../../features/host/service";
import { Button } from "../../../shared/design-system/ui/Button";
import { Field } from "../../../shared/design-system/ui/Field";
import { Dialog } from "../../../shared/design-system/ui/Dialog";
import { Textarea } from "../../../shared/design-system/ui/Textarea";

export function GitHubPolicyEditor({
  initialValue,
  onSave,
  onClose,
  path,
  finalFocus,
}: {
  initialValue: GithubPolicy;
  onSave(policy: GithubPolicy): Promise<void>;
  onClose(): void;
  path?: string;
  finalFocus?: React.ComponentProps<typeof Dialog>["finalFocus"];
}) {
  const [draft, setDraft] = useState(() => ({
    trustedOrganizations: initialValue.trustedOrganizations.join("\n"),
    trustedAuthors: initialValue.trustedAuthors.join("\n"),
    ignoredAuthors: initialValue.ignoredAuthors.join("\n"),
  }));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const form = useId();
  const dirty = Object.entries(draft).some(
    ([key, value]) =>
      value !== initialValue[key as keyof typeof draft].join("\n"),
  );
  const field = (
    key: keyof typeof draft,
    label: string,
    description: string,
  ) => (
    <Field label={label} description={description}>
      <Textarea
        rows={3}
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
        autoComplete="off"
        value={draft[key]}
        disabled={pending}
        onChange={(event) => {
          setDraft({ ...draft, [key]: event.target.value });
        }}
      />
    </Field>
  );
  const submit = async () => {
    if (pending || !dirty) return;
    setPending(true);
    setError("");
    const entries = (value: string) =>
      value
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    try {
      await onSave({
        version: 1,
        trustedOrganizations: entries(draft.trustedOrganizations),
        trustedAuthors: entries(draft.trustedAuthors),
        ignoredAuthors: entries(draft.ignoredAuthors),
      });
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      open
      title="GitHub comment authors"
      description="Comments and reviews from these authors wake your agents."
      headerGap="compact"
      bodyLayout="flex"
      preventClose={pending}
      finalFocus={finalFocus}
      onOpenChange={(next) => {
        if (!next && !pending) onClose();
      }}
      actions={
        <>
          <Button variant="subtle" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={form}
            variant="primary"
            loading={pending}
            disabled={!dirty || pending}
          >
            Save
          </Button>
        </>
      }
    >
      <form
        id={form}
        aria-label="GitHub author allowlist"
        className="grid min-h-0 gap-4 overflow-y-auto"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {field(
          "trustedOrganizations",
          "Trusted organizations",
          "One GitHub organization login per line. No commas.",
        )}
        {field(
          "trustedAuthors",
          "Trusted commenters",
          "One exact GitHub login per line, including bot logins. No commas.",
        )}
        {field(
          "ignoredAuthors",
          "Ignored commenters",
          "One exact GitHub login per line. No commas. These never wake agents, even in a trusted organization.",
        )}
        {error && (
          <p role="alert" className="text-body-sm text-danger">
            {error}
          </p>
        )}
        {path && (
          <p className="m-0 text-caption text-subtle">
            Preferences file: <code>{path}</code>
          </p>
        )}
      </form>
    </Dialog>
  );
}

export function GitHubPolicyPanel({
  host,
}: {
  host: Pick<Host, "spawn"> | undefined;
}) {
  const [status, setStatus] = useState<GithubPolicyStatus>();
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(true);
  const trigger = useRef<HTMLButtonElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry and opening the editor explicitly re-read the shared file.
  useEffect(() => {
    if (!host?.spawn) return;
    let active = true;
    setLoading(true);
    githubPolicy(host).then(
      (value) => {
        if (active) {
          setStatus(value);
          setError("");
          setLoading(false);
        }
      },
      (reason) => {
        if (active) {
          setError(String(reason instanceof Error ? reason.message : reason));
          setLoading(false);
        }
      },
    );
    return () => {
      active = false;
    };
  }, [host, retry]);
  if (!host?.spawn)
    return (
      <p className="text-body-sm text-subtle">
        GitHub author allowlist settings require the desktop host.
      </p>
    );
  return (
    <section className="attention-policy" aria-label="GitHub author settings">
      {error && (
        <p role="alert" className="text-body-sm text-danger">
          {error}
        </p>
      )}
      {!status && !error && (
        <p role="status" className="text-body-sm text-subtle">
          Loading GitHub author settings…
        </p>
      )}
      {status?.warning && (
        <div role="status" className="attention-policy-notice">
          <h3 className="text-label-sm text-warning">
            GitHub comments and reviews are off
          </h3>
          <p className="text-body-sm text-secondary">
            Add trusted organizations or commenters to receive them. CI and
            PR-state monitoring continue.
          </p>
        </div>
      )}
      {status?.error && (
        <p role="alert" className="text-body-sm text-danger">
          {status.error}
        </p>
      )}
      <div className="attention-actions">
        <Button
          ref={trigger}
          size="sm"
          variant="subtle"
          aria-haspopup="dialog"
          aria-disabled={loading}
          aria-busy={loading}
          onClick={() => {
            if (loading) return;
            if (!error) setOpen(true);
            setLoading(true);
            setRetry((value) => value + 1);
          }}
        >
          {error
            ? "Retry GitHub author settings"
            : status?.warning
              ? "Edit allowlist"
              : "GitHub allowlist"}
        </Button>
      </div>
      {open && !loading && !error && status && (
        <GitHubPolicyEditor
          initialValue={status.policy}
          path={status.path}
          finalFocus={trigger}
          onClose={() => setOpen(false)}
          onSave={async (policy) => {
            const value = await githubPolicy(host, policy);
            if (value.error) throw new Error(value.error);
            setStatus(value);
          }}
        />
      )}
    </section>
  );
}
