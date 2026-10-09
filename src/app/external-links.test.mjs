import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

it("grants only HTTP(S) opening to the main webview, without file or application access", () => {
  const capability = JSON.parse(
    read("../../src-tauri/capabilities/default.json"),
  );
  expect(capability.webviews).toEqual(["main"]);
  expect(capability.windows).toBeUndefined();
  expect(capability.remote).toBeUndefined();
  const openerPermissions = capability.permissions.filter((permission) =>
    (typeof permission === "string"
      ? permission
      : permission.identifier
    ).startsWith("opener:"),
  );
  expect(openerPermissions).toEqual([
    {
      identifier: "opener:allow-open-url",
      allow: [{ url: "https://*" }, { url: "http://*" }],
    },
  ]);
});
