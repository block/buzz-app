import { GhUnavailable, type GitHubCli } from "../github/gh";
import { repositoryName, type AdmissionChecks } from "./configuration";
import { publicJson } from "./pull-facts";

export type AdmissionFacts = {
  head: string;
  open: boolean;
  draft: boolean;
  mergeable: boolean | null;
  ci: "pass" | "fail" | "pending" | "none";
};
export type ReadAdmission = (
  repository: string,
  pr: number,
  checks: AdmissionChecks,
  signal: AbortSignal,
) => Promise<AdmissionFacts>;
const QUERY = `query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){pullRequest(number:$pr){
 state isDraft mergeable headRefOid commits(last:1){nodes{commit{oid statusCheckRollup{state}}}}
}}}`;
function checked(value: AdmissionFacts) {
  if (
    !/^[0-9a-f]{40,64}$/i.test(value.head) ||
    typeof value.open !== "boolean" ||
    typeof value.draft !== "boolean" ||
    (value.mergeable !== null && typeof value.mergeable !== "boolean") ||
    !["pass", "fail", "pending", "none"].includes(value.ci)
  )
    throw new Error("GitHub returned incomplete admission data. Try again.");
  return value;
}
export function admissionFailure(
  checks: AdmissionChecks,
  facts: AdmissionFacts,
): string | undefined {
  checked(facts);
  if (!facts.open) return "The PR is closed or merged.";
  if (checks.ready && facts.draft)
    return "The PR is still a draft. Mark it ready for review.";
  if (checks.ci && facts.ci !== "pass")
    return facts.ci === "fail"
      ? "CI has failing checks."
      : facts.ci === "none"
        ? "No CI result is available."
        : "CI is still pending.";
  if (checks.conflicts && facts.mergeable !== true)
    return facts.mergeable === false
      ? "The PR has merge conflicts."
      : "GitHub is still calculating merge conflicts. Try again.";
}
export function createAdmissionReader(gh?: GitHubCli): ReadAdmission {
  return async (input, pr, checks, signal) => {
    const repository = repositoryName(input);
    if (!Number.isSafeInteger(pr) || pr < 1)
      throw new Error("Invalid PR number.");
    if (gh) {
      try {
        const [owner, name] = repository.split("/");
        const response = await gh<{
          repository: {
            pullRequest: {
              state: string;
              isDraft: boolean;
              mergeable: string;
              headRefOid: string;
              commits: {
                nodes: {
                  commit: {
                    oid: string;
                    statusCheckRollup: { state: string } | null;
                  };
                }[];
              };
            } | null;
          } | null;
        }>(QUERY, { owner, name, pr }, signal);
        const pull = response.repository?.pullRequest;
        if (
          !pull ||
          !["OPEN", "CLOSED", "MERGED"].includes(pull.state) ||
          !["MERGEABLE", "CONFLICTING", "UNKNOWN"].includes(pull.mergeable)
        )
          throw new Error("GitHub admission data is unavailable.");
        const commit = pull.commits.nodes[0]?.commit;
        if (commit?.oid !== pull.headRefOid)
          throw new Error(
            "The PR changed while checking admission. Try again.",
          );
        const state = commit.statusCheckRollup?.state;
        if (
          state &&
          !["SUCCESS", "FAILURE", "ERROR", "PENDING", "EXPECTED"].includes(
            state,
          )
        )
          throw new Error("GitHub returned an unknown CI state.");
        return checked({
          head: pull.headRefOid,
          open: pull.state === "OPEN",
          draft: pull.isDraft,
          mergeable:
            pull.mergeable === "UNKNOWN"
              ? null
              : pull.mergeable === "MERGEABLE",
          ci: !state
            ? "none"
            : state === "SUCCESS"
              ? "pass"
              : ["FAILURE", "ERROR"].includes(state)
                ? "fail"
                : "pending",
        });
      } catch (error) {
        if (!(error instanceof GhUnavailable) || signal.aborted) throw error;
      }
    }
    const endpoint = `https://api.github.com/repos/${repository}`;
    const pull = await publicJson(`${endpoint}/pulls/${pr}`, signal);
    if (!["open", "closed"].includes(pull.state))
      throw new Error("GitHub returned an unknown PR state.");
    let ci: AdmissionFacts["ci"] = "none";
    if (checks.ci) {
      if (
        typeof pull.head?.sha !== "string" ||
        !/^[0-9a-f]{40,64}$/i.test(pull.head.sha)
      )
        throw new Error("GitHub returned an invalid PR commit.");
      const [statuses, runs] = await Promise.all([
        publicJson(
          `${endpoint}/commits/${pull.head.sha}/status?per_page=100`,
          signal,
        ),
        publicJson(
          `${endpoint}/commits/${pull.head.sha}/check-runs?per_page=100&filter=latest`,
          signal,
        ),
      ]);
      if (
        !Array.isArray(statuses.statuses) ||
        !Array.isArray(runs.check_runs) ||
        !Number.isSafeInteger(statuses.total_count) ||
        !Number.isSafeInteger(runs.total_count) ||
        statuses.total_count !== statuses.statuses.length ||
        runs.total_count !== runs.check_runs.length
      )
        throw new Error(
          "CI results are incomplete. Admission supports up to 100 statuses and 100 check runs.",
        );
      const results: string[] = statuses.statuses.map(
        (item: { state: string }) =>
          item.state === "success"
            ? "pass"
            : ["failure", "error"].includes(item.state)
              ? "fail"
              : "pending",
      );
      results.push(
        ...runs.check_runs.map(
          (run: { status: string; conclusion: string | null }) =>
            run.status !== "completed"
              ? "pending"
              : ["success", "neutral", "skipped"].includes(run.conclusion ?? "")
                ? "pass"
                : "fail",
        ),
      );
      ci = !results.length
        ? "none"
        : results.includes("fail")
          ? "fail"
          : results.includes("pending")
            ? "pending"
            : "pass";
    }
    return checked({
      head: pull.head?.sha,
      open: pull.state === "open",
      draft: pull.draft,
      mergeable: pull.mergeable,
      ci,
    });
  };
}
