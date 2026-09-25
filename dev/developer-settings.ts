import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";
import {
  DEFAULT_LOG_LEVEL,
  DEVELOPER_SETTINGS_PATH,
  LOG_LEVEL_EVENT,
  getLogger,
  isLogLevel,
  logLevel,
  setLogLevel,
} from "../src/features/developer/logging.ts";

/** Worktree-local dev preferences, independent of the broker's identity/relay. */
export function developerSettingsPlugin(root: string): Plugin {
  const directory = join(root, ".buzz");
  const file = join(directory, "developer-settings.json");
  setLogLevel(DEFAULT_LOG_LEVEL);
  try {
    const saved = JSON.parse(readFileSync(file, "utf8"));
    if (!isLogLevel(saved.logLevel)) throw new Error("Invalid log level");
    setLogLevel(saved.logLevel);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      getLogger("developer").warn(
        "Could not read saved log level; using Info.",
      );
  }
  return {
    name: "buzz-developer-settings",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url?.split("?")[0] !== DEVELOPER_SETTINGS_PATH) return next();
        const reply = (status: number, body: object) => {
          res.writeHead(status, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          });
          res.end(JSON.stringify(body));
        };
        const origin = `http://${req.headers.host ?? ""}`;
        if (
          !/^(localhost|127\.0\.0\.1):\d+$/.test(req.headers.host ?? "") ||
          (req.method === "POST" && req.headers.origin !== origin) ||
          (req.headers.origin && req.headers.origin !== origin) ||
          (req.headers["sec-fetch-site"] &&
            req.headers["sec-fetch-site"] !== "same-origin")
        )
          return reply(403, { error: "Origin rejected" });
        if (req.method === "GET") return reply(200, { logLevel: logLevel() });
        if (req.method !== "POST")
          return reply(405, { error: "Method not allowed" });
        try {
          let raw = "";
          for await (const part of req) {
            raw += part;
            if (raw.length > 256)
              return reply(413, { error: "Settings request too large" });
          }
          let value: unknown;
          try {
            value = JSON.parse(raw);
          } catch {
            return reply(400, { error: "Invalid settings" });
          }
          if (
            !value ||
            typeof value !== "object" ||
            !("logLevel" in value) ||
            Object.keys(value).length !== 1 ||
            !isLogLevel(value.logLevel)
          )
            return reply(400, { error: "Invalid settings" });
          // Synchronous atomic replacement serializes these tiny local writes. Apply
          // only after persistence succeeds, so a failed save cannot claim success.
          mkdirSync(directory, { recursive: true });
          writeFileSync(`${file}.tmp`, `${JSON.stringify(value)}\n`, {
            mode: 0o600,
          });
          renameSync(`${file}.tmp`, file);
          setLogLevel(value.logLevel);
          server.ws.send({
            type: "custom",
            event: LOG_LEVEL_EVENT,
            data: value.logLevel,
          });
          reply(200, { logLevel: logLevel() });
        } catch {
          reply(500, { error: "Could not save development settings" });
        }
      });
    },
  };
}
