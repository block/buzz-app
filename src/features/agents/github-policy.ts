import type { Host } from "../host/service";

export type GithubPolicy = Readonly<{
  version: 1;
  trustedOrganizations: string[];
  trustedAuthors: string[];
  ignoredAuthors: string[];
}>;
export type GithubPolicyStatus = Readonly<{
  path: string;
  policy: GithubPolicy;
  configured: boolean;
  warning: string | null;
  error: string | null;
}>;
/** The same user-owned file the GitHub producer reads. Saving requires an
 * explicit user request, including when an agent performs the edit. */
export async function githubPolicy(
  host: Pick<Host, "spawn">,
  policy?: GithubPolicy,
): Promise<GithubPolicyStatus> {
  if (!host.spawn) throw new Error("GitHub policy requires the desktop host");
  let output = "",
    error = "";
  const process = await host.spawn("attention-policy", {
    args: policy ? ["write", JSON.stringify(policy)] : ["read"],
    onStdout: (data) => {
      output += data;
    },
    onStderr: (data) => {
      error += data;
    },
  });
  if ((await process.exited) !== 0)
    throw new Error(error.trim() || "Could not read or save GitHub policy");
  return JSON.parse(output) as GithubPolicyStatus;
}
