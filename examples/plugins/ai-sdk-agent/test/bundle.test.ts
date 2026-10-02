// The built artifact, loaded the way the app loads it: one module, capabilities from ctx.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentType } from "@buzz/author";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const id = (letter: string) => letter.repeat(64);

test("the bundle registers one agent type whose form and subscription work", async () => {
  // @ts-expect-error built by `npm run build`; it has no declarations.
  const plugin = await import("../dist/plugin.js");
  assert.deepEqual(plugin.inject, ["react", "relay", "host", "agentTypes"]);
  const types: AgentType[] = [];
  plugin.apply({
    react: React,
    host: {},
    relay: {},
    agentTypes: { register: (type: AgentType) => types.push(type) },
  });
  assert.equal(types.length, 1);
  const [type] = types;
  assert.ok(type);
  // What AgentTypesService.register requires.
  assert.match(type.id, /^[a-z0-9][a-z0-9._-]*$/);
  assert.ok(type.title);
  assert.equal(typeof type.run, "function");
  // A run may read, build and test for a long while, one run at a time.
  assert.equal(type.timeoutMs, 30 * 60_000);
  assert.equal(type.concurrency, 1);
  assert.equal(type.workspace, true);
  assert.deepEqual(
    type.subscription(type.defaults, { pubkey: id("f"), owner: id("1") }),
    {
      kinds: [9],
      "#p": [id("f")],
    },
  );
  // The key is a secret the host asks for and keeps; the plugin's form and
  // config never hold it.
  assert.deepEqual(
    type.secrets?.map((secret) => secret.name),
    ["API_KEY"],
  );
  assert.ok(type.secrets?.[0]?.label);
  assert.ok(!type.secrets?.[0]?.optional);
  assert.equal(type.validate, undefined);
  const defaults = type.defaults as object;
  assert.ok(!("apiKey" in defaults));

  const form = renderToStaticMarkup(
    React.createElement(type.Configure, {
      config: { ...defaults, provider: "openai", apiKey: "sk-secret" },
      disabled: false,
      onChange: () => {},
    }),
  );
  for (const label of ["Provider", "Model", "Instructions"])
    assert.ok(form.includes(label), label);
  assert.doesNotMatch(form, /sk-secret|password/);
  assert.match(form, /placeholder="gpt-5-mini"/);
  assert.match(form, /<option value="openai" selected="">OpenAI<\/option>/);
});
