import { useEffect, useState } from "react";
import {
  githubPolicy,
  type GithubPolicy,
  type GithubPolicyStatus,
} from "../../../features/agents/github-policy";
import type { Host } from "../../../features/host/service";
import { Button } from "../../../shared/design-system/ui/Button";
import { Field } from "../../../shared/design-system/ui/Field";
import { InlineHeader } from "../../../shared/design-system/ui/Header";
import { SettingsGroup } from "../../../shared/design-system/ui/SettingsGroup";
import { Textarea } from "../../../shared/design-system/ui/Textarea";

export function GitHubPolicyEditor({
  initialValue,
  onSave,
}: {
  initialValue: GithubPolicy;
  onSave(policy: GithubPolicy): Promise<void>;
}) {
  const [draft, setDraft] = useState(() => ({
    trustedOrganizations: initialValue.trustedOrganizations.join("\n"),
    trustedAuthors: initialValue.trustedAuthors.join("\n"),
    ignoredAuthors: initialValue.ignoredAuthors.join("\n"),
  }));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const field = (
    key: keyof typeof draft,
    label: string,
    description: string,
  ) => (
    <Field label={label} description={description}>
      <Textarea
        value={draft[key]}
        disabled={pending}
        onChange={(event) => {
          setDraft({ ...draft, [key]: event.target.value });
          setSaved(false);
        }}
      />
    </Field>
  );
  const submit = async () => {
    if (pending) return;
    setPending(true);
    setError("");
    setSaved(false);
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
      setSaved(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(false);
    }
  };
  return (
    <form
      aria-label="GitHub author allowlist"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <InlineHeader
        title="GitHub comment authors"
        subtitle="Choose trusted organizations and/or individual commenters to receive comments and reviews. CI and PR-state monitoring continue with empty trusted lists."
      />
      <SettingsGroup layout="form">
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
          "One exact GitHub login per line.",
        )}
        {error && (
          <p role="alert" className="text-body-sm text-danger">
            {error}
          </p>
        )}
        {saved && (
          <p role="status" className="text-body-sm text-secondary">
            GitHub author allowlist saved.
          </p>
        )}
        <div className="attention-actions">
          <Button type="submit" size="sm" variant="primary" disabled={pending}>
            Save allowlist
          </Button>
        </div>
      </SettingsGroup>
    </form>
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
  const [saving, setSaving] = useState(false);
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
        <p role="status" className="text-body-sm text-warning">
          {status.warning}
        </p>
      )}
      {status?.error && (
        <p role="alert" className="text-body-sm text-danger">
          {status.error}
        </p>
      )}
      {status && (
        <p className="text-caption text-subtle">
          Preferences file: <code>{status.path}</code>
        </p>
      )}
      <div className="attention-actions">
        {status && (
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={open}
            disabled={saving}
            onClick={() => {
              setOpen(!open);
              if (!open) setRetry((value) => value + 1);
            }}
          >
            {open ? "Cancel editing allowlist" : "Edit GitHub author allowlist"}
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
          onSave={async (policy) => {
            setSaving(true);
            try {
              const value = await githubPolicy(host, policy);
              if (value.error) throw new Error(value.error);
              setStatus(value);
            } finally {
              setSaving(false);
            }
          }}
        />
      )}
    </section>
  );
}
