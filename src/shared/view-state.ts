// View intent is durable and explicitly partitioned; connection generations are not storage keys.
export function readView<T>(scope: string, key: string, fallback: T): T {
  try {
    return (
      JSON.parse(
        localStorage.getItem(`buzz-view.v1:${JSON.stringify([scope, key])}`) ??
          "null",
      ) ?? fallback
    );
  } catch {
    return fallback;
  }
}
export function writeView(scope: string, key: string, value: unknown) {
  try {
    localStorage.setItem(
      `buzz-view.v1:${JSON.stringify([scope, key])}`,
      JSON.stringify(value),
    );
  } catch {
    /* Keep the in-memory editor usable when browser storage is unavailable. */
  }
}
