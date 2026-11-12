import { useCallback, useEffect, useState } from "react";
import { Accordion } from "../../shared/design-system/ui/Accordion";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Select } from "../../shared/design-system/ui/Select";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { SwitchPreferenceRow } from "../../shared/design-system/ui/SwitchPreferenceRow";
import type {
  GooseVoiceSettings,
  VoiceSettings as Values,
} from "./voice-settings";

export function VoiceSettings({ settings }: { settings: GooseVoiceSettings }) {
  const [saved, setSaved] = useState<Values>();
  const [draft, setDraft] = useState<Values>();
  const [custom, setCustom] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [enabled, setEnabled] = useState(settings.enabled);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const load = useCallback(async () => {
    setDraft(undefined);
    setStatus("");
    const value = await settings.read();
    setSaved(value);
    setDraft(value);
    setCustom(Boolean(value.endpoint));
    setStatus(await settings.availability());
  }, [settings]);
  useEffect(() => {
    void load().catch((reason) => setError(String(reason)));
  }, [load]);
  const needsKey =
    custom && (!saved?.saved || draft?.endpoint.trim() !== saved.endpoint);
  return (
    <Accordion
      variant="settings"
      items={[
        {
          value: "Goose voice",
          title: "Voice",
          content: (
            <div className="grid gap-4">
              <SettingsGroup>
                <SwitchPreferenceRow
                  label="Allow Goose in huddles"
                  description="On this device only."
                  checked={enabled}
                  disabled={busy || (!enabled && !draft)}
                  onCheckedChange={async (value) => {
                    setBusy(true);
                    setError("");
                    try {
                      await settings.setEnabled(value);
                      setStatus(await settings.availability());
                    } catch (reason) {
                      setError(String(reason));
                    } finally {
                      setEnabled(settings.enabled);
                      setBusy(false);
                    }
                  }}
                />
              </SettingsGroup>
              <p className="m-0 text-body-sm text-subtle">
                Shared with goose on this Mac. Existing calls use their current
                settings until you rejoin.
              </p>
              {draft ? (
                <SettingsGroup layout="form">
                  <Select
                    label="Voice provider"
                    variant="field"
                    valueLabel={custom ? "Custom" : "OpenAI"}
                    value={custom ? "custom" : "openai"}
                    disabled={busy}
                    groups={[
                      {
                        label: "",
                        options: [
                          { value: "openai", label: "OpenAI" },
                          {
                            value: "custom",
                            label: "Custom (GPT-Live compatible)",
                          },
                        ],
                      },
                    ]}
                    onValueChange={(value) => {
                      setCustom(value === "custom");
                      setKey("");
                    }}
                  />
                  {custom && (
                    <>
                      <Field
                        label="Sessions endpoint"
                        description={
                          draft.endpoint
                            .trim()
                            .toLowerCase()
                            .startsWith("http:")
                            ? "Not encrypted. Your key and conversation text travel over the network in plain text. Use a network you trust."
                            : "The full sessions URL."
                        }
                      >
                        <Input
                          value={draft.endpoint}
                          disabled={busy}
                          autoCapitalize="none"
                          spellCheck={false}
                          onChange={(event) => {
                            setDraft({
                              ...draft,
                              endpoint: event.target.value,
                            });
                            setKey("");
                          }}
                        />
                      </Field>
                      <Field
                        label="API key"
                        description={
                          needsKey
                            ? "Enter a key for this endpoint."
                            : "Saved. Leave blank to keep it."
                        }
                      >
                        <Input
                          type="password"
                          autoComplete="new-password"
                          value={key}
                          disabled={busy}
                          onChange={(event) => setKey(event.target.value)}
                        />
                      </Field>
                    </>
                  )}
                  <Field label="Voice model">
                    <Input
                      value={draft.model}
                      disabled={busy}
                      onChange={(event) =>
                        setDraft({ ...draft, model: event.target.value })
                      }
                    />
                  </Field>
                  <Field label="Voice name">
                    <Input
                      value={draft.voice}
                      disabled={busy}
                      onChange={(event) =>
                        setDraft({ ...draft, voice: event.target.value })
                      }
                    />
                  </Field>
                  {!custom && (
                    <p className="m-0 text-body-sm text-subtle">
                      Uses your OpenAI API key.
                    </p>
                  )}
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button
                      variant="primary"
                      loading={busy}
                      disabled={
                        busy ||
                        (custom &&
                          (!draft.endpoint.trim() || (needsKey && !key)))
                      }
                      onClick={async () => {
                        setBusy(true);
                        setError("");
                        try {
                          await settings.save({
                            ...draft,
                            endpoint: custom ? draft.endpoint : "",
                            key,
                          });
                          setKey("");
                          await load();
                        } catch (reason) {
                          setKey("");
                          await load().catch(() => setStatus(""));
                          setError(
                            reason instanceof Error
                              ? reason.message
                              : String(reason),
                          );
                        } finally {
                          setEnabled(settings.enabled);
                          setBusy(false);
                        }
                      }}
                    >
                      Save voice settings
                    </Button>
                  </div>
                </SettingsGroup>
              ) : (
                <p role="status">
                  {error
                    ? "Voice settings unavailable."
                    : "Loading voice settings…"}
                </p>
              )}
              {status && (
                <p role="status" className="m-0 text-body-sm">
                  {status}
                </p>
              )}
              {error && <p role="alert">{error}</p>}
            </div>
          ),
        },
      ]}
    />
  );
}
