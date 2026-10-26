import { useEffect, useId, useState } from "react";
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
}: {
  initialValue: GithubPolicy;
  onSave(policy: GithubPolicy): Promise<void>;
  onClose(): void;
  path?: string;
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
      preventClose={pending}
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
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {field(
          "trustedOrganizations",
          "Trusted organizations",
          "One GitHub organization login per line.",
        )}
        {field(
          "trustedAuthors",
          "Trusted commenters",
          "One exact GitHub login per line, including bot logins.",
        )}
        {field(
          "ignoredAuthors",
          "Ignored commenters",
          "One exact GitHub login per line. These never wake agents, even in a trusted organization.",
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry and opening the editor explicitly re-read the shared file.
  useEffect(() => {
    if (!host?.spawn) return;
    let active = true;
    setStatus(undefined);
    setError("");
    githubPolicy(host).then(
      (value) => {
        if (active) setStatus(value);
      },
      (reason) => {
        if (active)
          setError(String(reason instanceof Error ? reason.message : reason));
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
        {status && (
          <Button
            size="sm"
            variant="subtle"
            aria-haspopup="dialog"
            onClick={() => {
              setOpen(true);
              setRetry((value) => value + 1);
            }}
          >
            {status.warning ? "Edit allowlist" : "GitHub allowlist"}
          </Button>
        )}
        {error && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setRetry((value) => value + 1)}
          >
            Retry GitHub author settings
          </Button>
        )}
      </div>
      {open && status && (
        <GitHubPolicyEditor
          initialValue={status.policy}
          path={status.path}
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
