import type * as ReactModule from "react";
import { load, save } from "./settings.ts";
import { endpoint } from "./embed-client.ts";
import type { Embeddings } from "./embed.ts";

/** Settings owns navigation, column and contribution lifetime. */
export function embeddingCard(
  React: typeof ReactModule,
  embeddings: Embeddings,
) {
  return function EmbeddingSettings({ active }: { active(): boolean }) {
    const id = React.useId();
    const [draft, setDraft] = React.useState(load);
    const [pending, setPending] = React.useState(false);
    const [result, setResult] = React.useState("");
    const [error, setError] = React.useState("");
    const revision = React.useRef(0);
    React.useEffect(
      () => () => {
        revision.current++;
      },
      [],
    );
    const change = (
      field: "embeddingUrl" | "embeddingKey" | "queryPrefix" | "documentPrefix",
      value: string,
    ) => {
      if (!active()) return;
      revision.current++;
      setResult("");
      setError("");
      const next = { ...load(), ...draft, [field]: value };
      // A credential entered for one destination must never follow an edited URL.
      if (field === "embeddingUrl") next.embeddingKey = "";
      setDraft(next);
    };
    const apply = () => {
      if (!active()) return false;
      try {
        if (draft.embeddingUrl) endpoint(draft.embeddingUrl);
        save({
          ...load(),
          embeddingUrl: draft.embeddingUrl ?? "",
          embeddingKey: draft.embeddingKey ?? "",
          queryPrefix: draft.queryPrefix ?? "",
          documentPrefix: draft.documentPrefix ?? "",
        });
        embeddings.refresh();
        setResult(
          draft.embeddingUrl
            ? "Saved. Recent history is indexed after each turn."
            : "Lexical recall only. RAM index cleared.",
        );
        setError("");
        return true;
      } catch {
        setError(
          "Use a valid HTTPS or local HTTP server URL without credentials, query or fragment.",
        );
        return false;
      }
    };
    const test = async () => {
      if (!apply()) return;
      const current = ++revision.current;
      setPending(true);
      try {
        const result = await embeddings.test();
        if (active() && current === revision.current)
          setResult(
            `${result.model}: ${result.dimensions} dimensions · ${Math.round(result.ms)} ms`,
          );
      } catch {
        if (active() && current === revision.current)
          setError("Embedding test failed. Check the server, URL and key.");
      } finally {
        setPending(false);
      }
    };
    return (
      <div className="buzz-settings-group" data-layout="form">
        <p id={`${id}-help`} className="buzz-preference-row-description">
          Sends conversation text and eligible memory to this server. The index
          stays in RAM. Clear the URL and save for lexical recall only. The
          optional key is saved on this device.
        </p>
        {(
          [
            ["embeddingUrl", "Embedding server URL", "url"],
            ["embeddingKey", "API key (optional)", "password"],
            ["queryPrefix", "Query prefix (optional)", "text"],
            ["documentPrefix", "Document prefix (optional)", "text"],
          ] as const
        ).map(([field, label, type]) => (
          <div className="buzz-field" key={field}>
            <label className="buzz-field-label" htmlFor={`${id}-${field}`}>
              {label}
            </label>
            <input
              id={`${id}-${field}`}
              className="buzz-input"
              type={type}
              autoComplete="off"
              placeholder={
                field === "queryPrefix"
                  ? "task: search result | query: "
                  : field === "documentPrefix"
                    ? "title: none | text: "
                    : undefined
              }
              aria-describedby={`${id}-help`}
              value={draft[field] ?? ""}
              onChange={(event) => change(field, event.target.value)}
            />
          </div>
        ))}
        <div className="flex flex-wrap gap-2">
          <button type="button" className="buzz-button" onClick={apply}>
            Save
          </button>
          <button
            type="button"
            className="buzz-button"
            disabled={pending || !draft.embeddingUrl}
            onClick={() => void test()}
          >
            {pending ? "Testing…" : "Test"}
          </button>
        </div>
        {result && (
          <p role="status" className="buzz-preference-row-description">
            {result}
          </p>
        )}
        {error && (
          <p role="alert" className="buzz-preference-row-description">
            {error}
          </p>
        )}
      </div>
    );
  };
}
