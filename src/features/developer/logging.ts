import { createConsola } from "consola";

export const LOG_LEVELS = {
  silent: -999,
  error: 0,
  warn: 1,
  info: 3,
  debug: 4,
  trace: 5,
} as const;
export type LogLevel = keyof typeof LOG_LEVELS;
export const DEFAULT_LOG_LEVEL: LogLevel = "info";
export const DEVELOPER_SETTINGS_PATH = "/api/dev/settings";
export const LOG_LEVEL_EVENT = "buzz:log-level";
export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && Object.hasOwn(LOG_LEVELS, value);
}

let level: LogLevel = DEFAULT_LOG_LEVEL;
const loggers = new Map<string, ReturnType<typeof createConsola>>();
const listeners = new Set<() => void>();
export const logLevel = () => level;
export function subscribeLogLevel(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function setLogLevel(next: LogLevel) {
  level = next;
  // Consola's withTag creates independent instances; update every existing tag.
  for (const logger of loggers.values()) logger.level = LOG_LEVELS[next];
  for (const listener of listeners) listener();
}
export function getLogger(tag: string) {
  let logger = loggers.get(tag);
  if (!logger) {
    logger = createConsola({
      defaults: { tag },
      level: LOG_LEVELS[level],
      // Debug is a firehose, including repeated frames. Never coalesce traffic.
      throttle: 0,
    });
    loggers.set(tag, logger);
  }
  return logger;
}

export async function developerSettings(next?: LogLevel): Promise<LogLevel> {
  const response = await fetch(DEVELOPER_SETTINGS_PATH, {
    cache: "no-store",
    // Missing APIs must return 404, not Vite's HTML fallback (and its warmup).
    headers: {
      Accept: "application/json",
      ...(next ? { "Content-Type": "application/json" } : {}),
    },
    ...(next
      ? {
          method: "POST",
          body: JSON.stringify({ logLevel: next }),
        }
      : {}),
  });
  if (!response.ok)
    throw new Error(
      "Development settings are unavailable or could not be saved.",
    );
  const value: unknown = (await response.json()).logLevel;
  if (!isLogLevel(value))
    throw new Error("Invalid development settings response.");
  setLogLevel(value);
  return value;
}

// Only Vite development clients subscribe. Production never contacts this endpoint.
if (import.meta.hot) {
  const changed = (value: unknown) => {
    if (isLogLevel(value)) setLogLevel(value);
  };
  const refresh = () => {
    void developerSettings().catch(() => {});
  };
  import.meta.hot.on(LOG_LEVEL_EVENT, changed);
  import.meta.hot.on("vite:ws:connect", refresh);
  refresh();
  import.meta.hot.dispose(() => {
    import.meta.hot?.off(LOG_LEVEL_EVENT, changed);
    import.meta.hot?.off("vite:ws:connect", refresh);
  });
}
