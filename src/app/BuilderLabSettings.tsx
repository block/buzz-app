import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

type BuilderLabStatus =
  | { status: "notConfigured" }
  | { status: "loggedOut" }
  | { status: "available" }
  | { status: "error"; message: string };

type ViewState =
  | { kind: "idle" }
  | { kind: "loading" }
  | ({ kind: "result" } & BuilderLabStatus);

export function BuilderLabSettings({ active = true }: { active?: boolean }) {
  const [state, setState] = useState<ViewState>({ kind: "idle" });

  useEffect(() => {
    if (!active) {
      setState({ kind: "idle" });
      return;
    }

    let cancelled = false;
    setState({ kind: "loading" });
    if (!isTauri()) {
      setState({
        kind: "result",
        status: "error",
        message: "BuilderLab login status is available in the desktop app.",
      });
      return () => {
        cancelled = true;
      };
    }
    void invoke<BuilderLabStatus>("builderlab_session_status")
      .then((status) => {
        if (!cancelled) setState({ kind: "result", ...status });
      })
      .catch(
        () =>
          !cancelled &&
          setState({
            kind: "result",
            status: "error",
            message: "Could not check the BuilderLab login status.",
          }),
      );
    return () => {
      cancelled = true;
    };
  }, [active]);

  return (
    <section aria-labelledby="builderlab-settings-title">
      <h2 id="builderlab-settings-title" className="mt-0 mb-6 text-label">
        BuilderLab
      </h2>
      {state.kind === "idle" || state.kind === "loading" ? (
        <p role="status">Checking BuilderLab login…</p>
      ) : state.status === "available" ? (
        <p role="status">You are logged into BuilderLab</p>
      ) : state.status === "notConfigured" ? (
        <>
          <p role="status">BuilderLab is not configured</p>
          <p className="text-body-sm text-muted">
            Set <code>BUILDERLAB_URL</code> to the HTTPS origin in the
            environment used to launch the desktop app, then restart it.
          </p>
        </>
      ) : state.status === "loggedOut" ? (
        <>
          <p role="status">Login to BuilderLab via the bl cli</p>
          <p className="text-body-sm text-muted">
            Run <code>bl auth login</code> in Terminal, then return here.
          </p>
        </>
      ) : (
        <p role="alert">BuilderLab connection unavailable. {state.message}</p>
      )}
    </section>
  );
}
