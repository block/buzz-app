// A plain editor for an agent's attention objects, one JSON value per slug, that
// any agent type can offer as a tab. Validation is the spec's, at save.
import { useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import { validateObject } from "./attention";
import type { AgentViewProps } from "./service";

export function AttentionEditor({ agent, save }: AgentViewProps) {
  const objects = Object.values(agent.attention).sort((a, b) =>
    a.slug.localeCompare(b.slug),
  );
  return (
    <div className="grid gap-4">
      {objects.map((object) => (
        <ObjectEditor
          key={`${object.slug}:${object.modifiedAt}`}
          slug={object.slug}
          initial={JSON.stringify(object.value, null, 2)}
          save={save}
        />
      ))}
      <ObjectEditor key={objects.length} initial="" save={save} />
    </div>
  );
}

function ObjectEditor({
  slug: saved,
  initial,
  save,
}: {
  slug?: string;
  initial: string;
  save: AgentViewProps["save"];
}) {
  const [slug, setSlug] = useState(saved ?? "");
  const [text, setText] = useState(initial);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const run = async (value: unknown) => {
    setPending(true);
    setError("");
    try {
      await save({ attention: { [slug]: value as never } });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(false);
    }
  };
  const submit = () => {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      setError("Enter a JSON object");
      return;
    }
    const problem = validateObject(slug, value);
    if (problem) setError(problem);
    else void run(value);
  };
  return (
    <div className="grid gap-2">
      {saved ? (
        <h4 className="text-label">{saved}</h4>
      ) : (
        <Field
          label="New object slug"
          description="interest/<id> or watch/<id>"
        >
          <Input
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
          />
        </Field>
      )}
      <Field
        label={saved ? `${saved} value` : "Value"}
        labelVisibility={saved ? "hidden" : "visible"}
      >
        <Textarea
          variant="code"
          rows={6}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </Field>
      <div className="flex gap-2">
        <Button size="compact" loading={pending} onClick={submit}>
          {saved ? "Save" : "Add"}
        </Button>
        {saved && (
          <Button
            size="compact"
            disabled={pending}
            onClick={() => void run(null)}
          >
            Remove
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-body-sm">
          {error}
        </p>
      )}
    </div>
  );
}
