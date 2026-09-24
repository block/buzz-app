import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

type BuilderLabStatus =
  | { status: "notConfigured" }
  | { status: "loggedOut" }
  | { status: "available" }
  | { status: "error"; message: string };

type ViewState = { kind: "idle" | "loading" } | BuilderLabStatus;

export function BuilderLabSettings({ active = true }: { active?: boolean }) {
  const [state, setState] = useState<ViewState>({ kind: "idle" });

  useEffect(() => {
    if (!active || state.kind !== "idle") return;
    setState({ kind: "loading" });
    if (!isTauri()) {
      setState({
        status: "error",
        message: "BuilderLab login status is available in the desktop app.",
      });
      return;
    }
    void invoke<BuilderLabStatus>("builderlab_session_status")
      .then(setState)
      .catch(() =>
        setState({
          status: "error",
          message: "Could not check the BuilderLab login status.",
        }),
      );
  }, [active, state.kind]);

  return (
    <section aria-labelledby="builderlab-settings-title">
      <h2 id="builderlab-settings-title" className="mt-0 mb-6 text-label">
        BuilderLab
      </h2>
      {state.kind === "idle" || state.kind === "loading" ? (
        <p role="status">Checking BuilderLab login…</p>
      ) : state.status === "available" ? (
        <p role="status">You are logged into BuilderLab</p>
      ) : state.status === "notConfigured" || state.status === "loggedOut" ? (
        <>
          <p role="status">Login to BuilderLab via the bl cli</p>
          <p className="text-body-sm text-muted">
            Run <code>bl auth login</code> in Terminal, then return here.
          </p>
        </>
      ) : (
        <p role="alert">
          BuilderLab connection unavailable. {state.message}
        </p>
      )}
    </section>
  );
}
