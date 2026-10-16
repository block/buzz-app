import { useState, useSyncExternalStore } from "react";
import type { Agents, AgentsSnapshot } from "../features/agents/service";
import type {
  DecisionBackend,
  DecisionsService,
} from "../features/decisions/service";
import { isApplePlatform } from "../features/shortcuts/format";
import { Button } from "../shared/design-system/ui/Button";
import { Field } from "../shared/design-system/ui/Field";
import { Input } from "../shared/design-system/ui/Input";
import { Radio, RadioGroup } from "../shared/design-system/ui/RadioGroup";

const STATUS: Record<AgentsSnapshot["classifierKey"], string> = {
  checking: "Checking for a saved TypeSafe key…",
  saved: "A TypeSafe key is saved. Watch classifiers run.",
  missing: "No TypeSafe key is saved. Watch classifiers do not run.",
  unreadable:
    "The saved key could not be read from secure storage. Unlock it, or replace or remove the key. Until then, watched events pass unchecked.",
  refused:
    "TypeSafe refused the saved key. Replace it. Until then, watched events pass unchecked.",
};

const BACKENDS: readonly {
  value: DecisionBackend;
  label: string;
  description: string;
}[] = [
  {
    value: "block",
    label: "Block Jev",
    description:
      "Jev through Block's model gateway. It uses your Block sign-in, so you need no key.",
  },
  {
    value: "block-openai",
    label: "Block OpenAI",
    description:
      "OpenAI Decisions through Block's model gateway. It uses your Block sign-in.",
  },
  {
    value: "typesafe",
    label: "TypeSafe",
    description: "Jev from TypeSafe, with your own TypeSafe API key.",
  },
];

/** Chooses the service that answers decisions on this device, and sets or
 * removes the TypeSafe key its `typesafe` backend uses. The key goes straight
 * to native storage and is never shown again. */
export function DecisionsSettings({
  decisions,
  agents,
  active,
  apple = isApplePlatform(navigator.platform),
}: {
  decisions: Pick<DecisionsService, "backend" | "subscribe" | "setBackend">;
  agents: Pick<
    Agents,
    "snapshot" | "subscribe" | "setClassifierKey" | "clearClassifierKey"
  >;
  active(): boolean;
  /** Whether the key goes to the macOS Keychain, which keeps it from other
   * programs; Windows and Linux stores do not. */
  apple?: boolean;
}) {
  const state = useSyncExternalStore(
    agents.subscribe,
    agents.snapshot,
    agents.snapshot,
  );
  const backend = useSyncExternalStore(
    decisions.subscribe,
    decisions.backend,
    decisions.backend,
  );
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const desktop = state.status !== "unavailable";
  const keyState = state.classifierKey;
  // A key may be saved in each state but these two.
  const saved = keyState !== "missing" && keyState !== "checking";
  const run = async (action: () => Promise<void>) => {
    if (!active() || busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
      setKey("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  const service =
    backend === "typesafe"
      ? "TypeSafe (api.typesafe.ai)"
      : "Block's model gateway (kgoose.sqprod.co)";
  return (
    <div data-buzz-ui="" className="flex flex-col items-start gap-4">
      <div>
        <h2 className="text-heading text-primary">Decisions</h2>
        <p className="mt-2 text-body-sm text-secondary">
          Agent watches and plugins can ask a model short questions about a
          message, for example whether it is about a deploy. Choose the service
          that answers on this device. If it cannot answer, a watch still wakes
          its agent, and the agent is told the classifier did not run.
        </p>
      </div>
      {!desktop ? (
        <p role="status" className="text-body-sm text-secondary">
          Open the Buzz desktop app to choose a decision service.
        </p>
      ) : (
        <>
          <Field
            label="Decision service"
            labelVisibility="hidden"
            nativeLabel={false}
          >
            <RadioGroup
              aria-label="Decision service"
              value={backend}
              onValueChange={(value) => {
                if (active()) decisions.setBackend(value as DecisionBackend);
              }}
            >
              {BACKENDS.map((option) => (
                <Radio
                  key={option.value}
                  value={option.value}
                  variant="card"
                  label={option.label}
                  description={option.description}
                />
              ))}
            </RadioGroup>
          </Field>
          <p className="text-body-sm text-secondary">
            For each event a classified watch matches, Buzz sends {service} the
            whole event, with its text and tags; the author's display name and
            whether they are the agent's owner; the channel name; the first 600
            characters of the message it replies to; and who it mentions. This
            includes events in private channels. Plugins send what they choose.
            {backend === "typesafe"
              ? ""
              : " Block counts the cost of each call against your account."}
          </p>
          {backend === "typesafe" && (
            <>
              <p role="status" className="text-body-sm text-secondary">
                {STATUS[keyState]}{" "}
                {apple
                  ? "The key is kept in this Mac's Keychain, where only Buzz can read it."
                  : "The key is kept in this device's credential store. Other programs you run, agent shells included, can read it there."}
              </p>
              <form
                className="flex w-full max-w-md flex-col items-start gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  const value = key.trim();
                  if (value) void run(() => agents.setClassifierKey(value));
                }}
              >
                <Field label="TypeSafe API key">
                  <Input
                    type="password"
                    autoComplete="new-password"
                    spellCheck={false}
                    disabled={busy}
                    value={key}
                    placeholder={saved ? "Saved key unchanged" : "Paste a key"}
                    onChange={(event) => setKey(event.target.value)}
                  />
                </Field>
                <div className="flex gap-2">
                  <Button
                    type="submit"
                    variant="prominent"
                    disabled={busy || !key.trim()}
                  >
                    {saved ? "Replace key" : "Save key"}
                  </Button>
                  {saved && (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void run(() => agents.clearClassifierKey())
                      }
                    >
                      Remove key
                    </Button>
                  )}
                </div>
              </form>
              {error && (
                <p role="alert" className="text-body-sm text-danger">
                  {error}
                </p>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
