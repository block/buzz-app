import type { SqlJsStatic } from "sql.js";

let loading: Promise<SqlJsStatic> | undefined;

/** SQLite for agent tables. The inline build carries its WebAssembly inside
 * the script, so it loads the same way in the app's webview and in the
 * single-file MCP server, with no asset to locate. */
export function sqlite() {
  loading ??= import("sql.js/dist/sql-wasm-inline.js").then(
    ({ default: init }) => init(),
  );
  return loading;
}
