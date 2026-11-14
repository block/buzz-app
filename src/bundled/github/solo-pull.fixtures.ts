import type { PullDetails, PullState } from "./pull-states";
import type { PullChecklist } from "./pull";
import type { SoloPull } from "./solo-pull";

type FixturePull = SoloPull & {
  state: PullState & { details: PullDetails & { checklist: PullChecklist } };
};

export const approvedPull = (): FixturePull => ({
  url: "https://github.com/example/project/pull/7",
  state: {
    state: "open",
    head: "a".repeat(40),
    checks: "success",
    settled: true,
    details: {
      signedIn: true,
      details: {
        title: "Improve a feature",
        author: "developer",
        body: "",
        state: "open",
        facts: [],
      },
      checklist: {
        id: "PR_7",
        head: "a".repeat(40),
        base: "main",
        state: "open",
        checks: { state: "success", label: "Passed", description: "" },
        review: {
          decision: "APPROVED",
          approved: ["reviewer"],
          changes: [],
          waiting: [],
          complete: true,
        },
        unresolved: 0,
        moreThreads: false,
        merge: "CLEAN",
        canUpdate: true,
        canUpdateBranch: true,
        authored: true,
        canBypass: false,
        queueRequired: false,
        queued: false,
        methods: ["SQUASH"],
        method: "SQUASH",
        canEnableAutoMerge: false,
        canDisableAutoMerge: false,
      },
    },
  },
});
