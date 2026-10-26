import { useState } from "react";
import { Button } from "../../../shared/design-system/ui/Button";
import { Field } from "../../../shared/design-system/ui/Field";
import { InlineHeader } from "../../../shared/design-system/ui/Header";
import { SettingsGroup } from "../../../shared/design-system/ui/SettingsGroup";
import { Textarea } from "../../../shared/design-system/ui/Textarea";

// Shared file shape agreed with the GitHub source owner. Persistence stays with that owner.
export type GitHubAuthorPolicy = {
  version: 1;
  trustedOrganizations: string[];
  trustedAuthors: string[];
  ignoredAuthors: string[];
};

export function GitHubPolicyEditor({
  initialValue,
  onSave,
}: {
  initialValue: GitHubAuthorPolicy;
  onSave(policy: GitHubAuthorPolicy): Promise<void>;
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
