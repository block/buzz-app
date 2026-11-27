import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { HostProcess } from "../../src/features/host/service";
import { gitHubDiff, type GitHubCli } from "../../src/bundled/github/gh";
import { GitHubPanel } from "../../src/bundled/github/index";
import { createPanelMemory } from "../../src/bundled/github/panel-memory";
import { createPullStates } from "../../src/bundled/github/pull-states";
import { ToastProvider } from "../../src/shared/design-system/ui/Toast";
import "../../src/shared/styles/globals.css";
// block/buzz-app#3984 as GitHub's compare API answered it: 24 files, 1,424
// changed lines in JavaScript, Rust, TypeScript, TSX and Markdown. Two
// TypeScript files are past the size the viewer highlights.
import patch from "./github-pull-changes.diff?raw";

// The real pull request panel over a scripted `gh`, built as the plugin's
// apply() builds it: one pull request store, panel memory and diff reader for
// every panel. Only the `gh` process is fake. It answers the diff after
// `ghMs` (default 500, about what `gh api` takes for this diff), in pieces as
// the host streams stdout.
const params = new URLSearchParams(location.search);
const ghMs = Number(params.get("ghMs") ?? 500);
const url = "https://github.com/block/buzz-app/pull/3984";
const head = "36fb56d0237d1917d682a9e72028eff4c1893718";

const gh = (async () => ({
  r0: {
    viewerDefaultMergeMethod: "SQUASH",
    squashMergeAllowed: true,
    mergeCommitAllowed: false,
    rebaseMergeAllowed: false,
    autoMergeAllowed: false,
    pullRequest: {
      id: "PR_3984",
      title: "Label migration writes in the plugin host",
      state: "OPEN",
      isDraft: false,
      body: "",
      author: { login: "me" },
      baseRefName: "main",
      headRefName: "label-migration-writes",
      headRefOid: head,
      headRepository: { nameWithOwner: "block/buzz-app" },
      headRepositoryOwner: { login: "block" },
      baseRepository: { nameWithOwner: "block/buzz-app" },
      additions: 1247,
      deletions: 177,
      changedFiles: 24,
      mergeStateStatus: "CLEAN",
      reviewDecision: null,
      viewerCanUpdate: true,
      viewerCanUpdateBranch: true,
      viewerCanMergeAsAdmin: false,
      viewerCanEnableAutoMerge: false,
      viewerCanDisableAutoMerge: false,
      autoMergeRequest: null,
      reviewRequests: { nodes: [] },
      latestOpinionatedReviews: { nodes: [] },
      reviewThreads: { nodes: [] },
      commits: { nodes: [] },
    },
  },
})) as unknown as GitHubCli;

const reads = { count: 0 };
const PIECE = 64 * 1024;
const diff = gitHubDiff({
  async spawn(_id, { onStdout } = {}) {
    reads.count++;
    let exit!: (code: number | null) => void;
    const exited = new Promise<number | null>((resolve) => {
      exit = resolve;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    return {
      write: async () => {},
      async end() {
        timer = setTimeout(() => {
          for (let at = 0; at < patch.length; at += PIECE)
            onStdout?.(patch.slice(at, at + PIECE));
          exit(0);
        }, ghMs);
      },
      async kill() {
        clearTimeout(timer);
        exit(null);
      },
      exited,
    } satisfies HostProcess;
  },
});
const states = createPullStates(gh);
const memory = createPanelMemory();

declare global {
  interface Window {
    pullChanges: {
      open(): void;
      close(): void;
      readonly diffReads: number;
    };
  }
}

function Fixture() {
  const [open, setOpen] = useState(true);
  window.pullChanges = {
    open: () => setOpen(true),
    close: () => setOpen(false),
    get diffReads() {
      return reads.count;
    },
  };
  // About the side panel's width beside a channel, scrolling as it does.
  return (
    <aside
      aria-label="GitHub"
      style={{ width: 680, height: "100vh", overflow: "auto", padding: 16 }}
    >
      {open && (
        <GitHubPanel
          target={url}
          close={() => setOpen(false)}
          gh={gh}
          diff={diff}
          states={states}
          memory={memory}
        />
      )}
    </aside>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(
  <ToastProvider>
    <Fixture />
  </ToastProvider>,
);
