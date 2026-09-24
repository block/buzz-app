export function isProxySource(source: string): boolean {
  try {
    const hasWindow = typeof window !== "undefined";
    const url = new URL(
      source,
      hasWindow ? window.location.href : "https://app.test",
    );
    const sameOrigin =
      source.startsWith("/") ||
      (hasWindow && url.origin === window.location.origin);
    return (
      sameOrigin &&
      url.pathname.startsWith("/api/relay") &&
      url.pathname.endsWith("/media")
    );
  } catch {
    return false;
  }
}

export function safeOpenUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}
