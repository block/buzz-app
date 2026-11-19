import { useMemo, useState } from "react";
import { createTwoFilesPatch } from "diff";
import { BASE_PROMPT } from "../features/agent-harness/base-prompt";
import {
  setBasePromptPreference,
  useBasePromptPreference,
} from "../features/agent-harness/base-prompt-preference";
import { Accordion } from "../shared/design-system/ui/Accordion";
import { Button } from "../shared/design-system/ui/Button";
import { Field } from "../shared/design-system/ui/Field";
import { InlineHeader } from "../shared/design-system/ui/Header";
import { SettingsGroup } from "../shared/design-system/ui/SettingsGroup";
import { Textarea } from "../shared/design-system/ui/Textarea";
import { DiffViewer } from "../bundled/diffs/DiffViewer";
import { parsePatch } from "../bundled/diffs/parse";

/** Advanced editing stays in the existing settings surface, beside a live diff. */
export function BasePromptSettings() {
  const saved = useBasePromptPreference();
  const [draft, setDraft] = useState(() => ({
    source: saved,
    text: saved ?? BASE_PROMPT,
  }));
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const conflict = saved !== draft.source;
  const dirty = draft.text !== (draft.source ?? BASE_PROMPT);
  const patch = useMemo(
    () =>
      createTwoFilesPatch(
        "base_prompt.md",
        "base_prompt.md",
        BASE_PROMPT,
        draft.text,
      ).replace(/^Index: [^\n]*\n=+\n/, ""),
    [draft.text],
  );
  const files = useMemo(() => parsePatch(patch), [patch]);
  function apply(text: string | null) {
    const problem = setBasePromptPreference(text);
    setError(problem);
    if (problem) return;
    setDraft({ source: text, text: text ?? BASE_PROMPT });
    setNotice(
      text === null ? "Bundled default restored." : "Custom base prompt saved.",
    );
  }
  return (
    <div className="mt-section-gap">
      <InlineHeader title="Advanced" />
      <Accordion
        keepMounted
        variant="settings"
        items={[
          {
            value: "Base prompt",
            title: "Base prompt",
            content: (
              <div className="grid min-w-0 gap-section-gap">
                <p className="m-0 text-body-sm text-subtle">
                  {saved === null
                    ? "Using the bundled default."
                    : "Using a custom base prompt."}{" "}
                  This device only; applies across communities to agents run by
                  this app that use Buzz’s shared prompt builder. Your
                  replacement is used instead of the bundled text, not appended
                  to it. Other system instructions, tool guidance, and agent
                  instructions remain separate.
                </p>
                <p className="m-0 text-body-sm text-subtle">
                  Removing routing or tool instructions can stop agents from
                  working correctly in Buzz. After saving, use New in an agent
                  conversation to ensure it uses the changed prompt. Running
                  turns are not interrupted.
                </p>
                <SettingsGroup layout="form">
                  <Field
                    label="Base prompt replacement"
                    description="Saved exactly as written, including workspace guidance you maintain yourself. An empty replacement removes the shared base prompt. Save before closing Settings; unsaved edits are not kept."
                  >
                    <Textarea
                      variant="code"
                      rows={18}
                      value={draft.text}
                      onChange={(event) => {
                        setDraft({ ...draft, text: event.target.value });
                        setError(null);
                        setNotice("");
                      }}
                    />
                  </Field>
                  {conflict && (
                    <div className="grid gap-field-gap">
                      <p role="alert" className="m-0 text-body-sm text-subtle">
                        The saved prompt changed in another window. Load it
                        before saving; your draft has not been overwritten.
                      </p>
                      <Button
                        onClick={() => {
                          setDraft({
                            source: saved,
                            text: saved ?? BASE_PROMPT,
                          });
                          setError(null);
                          setNotice("");
                        }}
                      >
                        Load saved prompt
                      </Button>
                    </div>
                  )}
                  {error && (
                    <p role="alert" className="m-0 text-body-sm text-danger">
                      {error}
                    </p>
                  )}
                  {notice && (
                    <p role="status" className="m-0 text-body-sm text-subtle">
                      {notice}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      disabled={conflict || (saved === null && !dirty)}
                      onClick={() => apply(null)}
                    >
                      Restore bundled default
                    </Button>
                    <Button
                      disabled={conflict || !dirty}
                      variant="prominent"
                      onClick={() => apply(draft.text)}
                    >
                      Save base prompt
                    </Button>
                  </div>
                </SettingsGroup>
                <section aria-label="Base prompt diff">
                  <InlineHeader
                    title="Changes from bundled default"
                    subtitle="Live preview of your draft. Removed lines are marked −; added lines are marked +. The bundled original is never changed."
                  />
                  {draft.text === BASE_PROMPT ? (
                    <p className="m-0 text-body-sm text-subtle">
                      No changes from the bundled default.
                    </p>
                  ) : (
                    <DiffViewer
                      content={patch}
                      files={files}
                      filePath="base_prompt.md"
                    />
                  )}
                </section>
                <Field
                  label="Bundled original"
                  description="Read-only. Updates with Buzz; your saved replacement stays unchanged until you edit or restore it."
                >
                  <Textarea
                    variant="code"
                    rows={10}
                    readOnly
                    value={BASE_PROMPT}
                  />
                </Field>
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}
