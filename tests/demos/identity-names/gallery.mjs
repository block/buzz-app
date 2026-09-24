import { readFile, writeFile } from "node:fs/promises";
const out = process.env.DEMO_OUTPUT ?? "test-results/identity-names-demo";
const policy = JSON.parse(
  await readFile(`${out}/POLICY_CAPTURES.json`, "utf8"),
);
const surfaces = JSON.parse(
  await readFile(`${out}/SURFACE_CAPTURES.json`, "utf8"),
);
const escapeHtml = (s) =>
  String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll('"', "&quot;");
const section = (name, shots) =>
  `<h2>${name}</h2>${shots.map((s) => `<section id="${escapeHtml(s.id)}"><h3>${escapeHtml(s.id)}</h3><p>${escapeHtml(s.description)}</p><a href="${escapeHtml(s.id)}.png"><img loading="lazy" src="${escapeHtml(s.id)}.png" alt="${escapeHtml(s.description)}"></a></section>`).join("\n")}`;
await writeFile(
  `${out}/INDEX.html`,
  `<!doctype html><html lang="en"><meta charset="utf-8"><title>Buzz naming conflict demo</title><style>body{font:16px system-ui;max-width:1440px;margin:32px auto;padding:20px;background:#f5f7fa;color:#17202a}section{background:white;padding:20px;margin:24px 0;border:1px solid #ddd;border-radius:12px}img{max-width:100%;height:auto}p{max-width:100ch}</style><h1>Buzz naming conflict demo</h1><p>Real application UI, synthetic identities and local transport. No real community data. Naming production head: fe164114a4d19f3e76182755e1d579ac8e97c156. Capture head: ${escapeHtml(policy.head)}. Chromium ${escapeHtml(policy.browser)}. See JSON manifests for the exact working state.</p><p>Agent management/editor use the production UI with a modeled, read-only native host, not a native process. Notification text is captured at the browser API boundary in <a href="NOTIFICATION_PAYLOAD.json">NOTIFICATION_PAYLOAD.json</a>; no genuine OS notification screenshot is available. Native title tooltips are asserted by DOM attributes, not photographed.</p><p>Plain unbound @name text does not become a person reference. The reachable sent-mention surface is captured; ReferenceText receives no person recipients in the current production caller.</p>${section("Decision cases", policy.shots)}${section("UX surfaces", surfaces.shots)}</html>`,
);
console.log(`${out}/INDEX.html`);
