import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  checkIconManifest,
  checkIconGateway,
} from "../../scripts/design-system/check-icons.mjs";

test("icon dependency policy rejects retired families and aliases", () => {
  for (const name of [
    "lucide-react",
    "@tabler/icons-react",
    "react-icons",
    "@heroicons/react",
  ])
    assert.equal(
      checkIconManifest({ dependencies: { [name]: "1" } }).length,
      1,
    );
  assert.equal(
    checkIconManifest({ devDependencies: { sneaky: "npm:lucide-react@1" } })
      .length,
    1,
  );
  assert.deepEqual(
    checkIconManifest({
      dependencies: {
        "@phosphor-icons/react": "2.1.10",
        "@phosphor-icons/core": "2.1.1",
      },
    }),
    [],
  );
});
test("gateway allows individual exports, never the whole catalog", () => {
  const path = "src/shared/design-system/icons/index.ts";
  assert.deepEqual(
    checkIconGateway(
      path,
      'export { HouseIcon } from "@phosphor-icons/react/dist/csr/House";',
    ),
    [],
  );
  assert.ok(
    checkIconGateway(path, 'export * from "@phosphor-icons/react";').length,
  );
});
test("real local linter rejects upstream imports outside the gateway", () => {
  for (const specifier of [
    "lucide-react",
    "@tabler/icons-react",
    "@phosphor-icons/react",
    "@phosphor-icons/react/dist/csr/House",
    "@phosphor-icons/core/assets/regular/house.svg?raw",
  ]) {
    const dir = mkdtempSync(join(tmpdir(), "buzz-icon-policy-"));
    const file = join(dir, "probe.ts");
    writeFileSync(
      file,
      `import { HouseIcon } from "${specifier}";\nexport { HouseIcon };\n`,
    );
    const result = spawnSync(
      "bin/pnpm",
      ["exec", "biome", "lint", "--config-path=biome.json", file],
      { encoding: "utf8" },
    );
    rmSync(dir, { recursive: true });
    assert.notEqual(result.status, 0, specifier);
    assert.match(result.stdout + result.stderr, /noRestrictedImports/);
  }
  execFileSync("bin/pnpm", [
    "exec",
    "biome",
    "lint",
    "src/shared/design-system/icons",
  ]);
});
test("icon checks are part of the normal design gate", () => {
  const { scripts } = JSON.parse(readFileSync("package.json", "utf8"));
  assert.match(scripts["design:check"], /check-icons.mjs/);
});
