import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CircleX } from "lucide-react";
import { fetchKlipyGifs, type KlipyGif } from "../../features/relay/gifs";
import styles from "./Emoji.module.css";

const LOADING_TILES = [
  "tall-a",
  "short-a",
  "short-b",
  "tall-b",
  "tall-c",
  "short-c",
  "short-d",
  "tall-d",
] as const;

export function GifPicker({
  community,
  initialQuery,
  onQueryChange,
  select,
}: {
  community: string;
  initialQuery: string;
  onQueryChange(query: string): void;
  select(gif: KlipyGif): void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [debouncedQuery, setDebouncedQuery] = useState(initialQuery.trim());
  const [gifs, setGifs] = useState<KlipyGif[]>();
  const [error, setError] = useState<string>();
  const [attempt, retry] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    input.current?.focus();
  }, []);
  useEffect(() => {
    const timeout = window.setTimeout(
      () => setDebouncedQuery(query.trim()),
      500,
    );
    return () => window.clearTimeout(timeout);
  }, [query]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly retries the same request.
  useEffect(() => {
    const controller = new AbortController();
    setError(undefined);
    setGifs(undefined);
    void fetchKlipyGifs(community, debouncedQuery, controller.signal).then(
      setGifs,
      (reason: unknown) => {
        if (!controller.signal.aborted)
          setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
    return () => controller.abort();
  }, [community, debouncedQuery, attempt]);

  return (
    <div className={styles.gifPicker}>
      <label className={styles.gifSearch}>
        <input
          ref={input}
          aria-label="Search GIFs"
          type="search"
          placeholder="Search GIFs"
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            onQueryChange(event.target.value);
          }}
        />
        {query && (
          <button
            className={styles.gifClear}
            type="button"
            aria-label="Clear"
            title="Clear"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              setQuery("");
              onQueryChange("");
              input.current?.focus();
            }}
          >
            <CircleX size={16} aria-hidden="true" />
          </button>
        )}
      </label>
      <div className={styles.gifResults}>
        {!gifs && !error ? (
          <div
            className={styles.gifLoading}
            role="status"
            aria-label="Loading GIFs"
          >
            {LOADING_TILES.map((tile) => (
              <span key={tile} />
            ))}
          </div>
        ) : error ? (
          <div className={styles.gifEmpty} role="alert">
            <p>{error}</p>
            <button type="button" onClick={() => retry(attempt + 1)}>
              Try again
            </button>
          </div>
        ) : gifs?.length ? (
          <div className={styles.gifGrid} data-testid="klipy-gif-grid">
            {gifs.map((gif) => (
              <button
                key={`${gif.id}-${gif.slug}`}
                type="button"
                aria-label={`Choose ${gif.title}`}
                title={gif.title}
                onClick={() => select(gif)}
              >
                <img
                  src={gif.preview.url}
                  alt={gif.title}
                  width={gif.preview.width}
                  height={gif.preview.height}
                  loading="lazy"
                />
              </button>
            ))}
          </div>
        ) : (
          <div className={styles.gifEmpty}>No GIFs found.</div>
        )}
      </div>
      <div className={styles.gifAttribution}>Powered by KLIPY</div>
    </div>
  );
}
