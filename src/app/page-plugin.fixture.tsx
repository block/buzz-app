import type { PluginModule } from "../plugins/api";
import { useEffect, useState } from "react";

export const pageFixtureState: {
  onMount?: (() => void) | undefined;
} = {};

function Beacon() {
  const [draft, setDraft] = useState("");
  useEffect(() => {
    pageFixtureState.onMount?.();
  }, []);
  return (
    <>
      <p>Beacon page content</p>
      <label>
        Page draft
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
    </>
  );
}

export const inject = ["pages"];
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.pages.register({
    id: "main",
    title: "Beacon",
    primary: true,
    component: Beacon,
    route: { version: 1, validate: (params) => typeof params === "string" },
  });
  ctx.pages.register({
    id: "plain",
    title: "Plain fixture",
    component: () => <p>Plain page content</p>,
  });
};
