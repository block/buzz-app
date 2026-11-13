# Review Configuration

An optional bundled plugin with a separate sidebar page for repository review
settings. Enable **Review Configuration** in Settings → Plugins → Manage plugins.
Choose a channel, register a GitHub repository, add named lanes, reviewer agents, and instructions,
and save. Open a repository row to manage its lanes. Saved cards show agents,
instructions, and routing rules. **Edit lane** opens one lane; **Save lane** persists
it before another can be added. **Back to lanes** cancels edits; **Back to repositories**
returns to the list. The main page has matching **Register repository**, **Submit PR**, and **Pull requests** actions above the **Repositories** section.

The **Submit PR** page has a full GitHub PR URL field and one
Submit button. It finds the saved repository in the selected channel, loads current
PR metadata, and assigns the first configured reviewer per matching lane. Missing
configuration, unavailable reviewers, and zero matching lanes produce an error
without starting threads. Results show assigned reviewers and thread buttons.
The separate **Pull requests** page shows previous submissions in a bordered table with review outcomes, reviewer identities, and thread links. The table shows GitHub status (Open, Draft, Closed, or Merged); Reload refreshes it. Remind is disabled for closed, merged, loading, or unavailable PRs and rechecks GitHub before sending. The table uses separate **Lane threads**, **Lane status**, and **Lane last message** columns, with one aligned row per lane. **Full message** is an underlined link in **Lane last message** that opens the source message in a popup without leaving the table; Back closes it, Forward restores it, and explicit Close retires that popup visit. Latest messages include ordinary replies and update while the page is open. The submitter can click **Remind** on an individual review lane to notify its saved reviewer in the existing thread, with an optional message included in the reminder, delivery feedback, and retry on failure. Pending retries preserve the originally saved message. Admission Triage has no Remind action. A lane reminder resets only that lane; other lanes keep their status. Finish an interrupted reminder in the same lane and browser profile before starting another. Older interrupted whole-PR batches show **Retry pending reminders**. Incomplete submissions must finish delivery through Submit PR first. The submitter can confirm **Delete** to remove a submission from the shared list. This does not stop active reviews, delete conversations, or close the GitHub PR. Submitting that URL again applies current routing and creates new reviewer threads.

Submitting an already-delivered PR sends a reviewer mention in each saved lane
thread. It preserves the saved reviewers and instructions and creates no new
threads. It resets each lane to Needs review. Incomplete original submissions resume delivery from
the original browser profile instead. Existing review notifications run only on Submit.
Agent admission continues automatically as described below.


Status colors retain their text labels: completed outcomes (including legacy
Completed · outcome unspecified) are green, pending review is amber, and changes
requested are red. Color does not imply GitHub approval. Submitted records created
by this version show their original submission date; older records say Not recorded.
Last reviewed is the latest valid result in the assigned review threads, including
previous reminder rounds; Reviewing acknowledgments do not change it. Times use
the viewer’s local timezone. If history exceeds the bounded read, current statuses
remain available and the date is explicitly unavailable.

The Pull requests dock badge counts PRs with unseen review updates in the selected
review channel. Each affected PR shows Updated and a Mark seen action. Opening the
page alone does not clear updates. Mark seen acknowledges the displayed status;
a later update marks the PR again. These preferences persist on this device,
separately for each signed-in identity, community, and channel. The dock and table
share an event-driven reader; there is no periodic polling.

All three pages use the shell's page navigation. Review Configuration and Pull requests each have their own dock icon. The first opens repository and lane setup; the second opens the PR list directly. Its Submit PR button opens the submission form. Existing configuration actions and Back buttons remain available. Repository and lane editing
remain local sections; reloading returns Configuration to its repository list.
Restarted submissions use a versioned delivery generation; older plugin versions cannot read or resume them.
The channel selection is remembered per identity/community; one eligible channel
is selected automatically. Submit results can be recovered from the Pull requests table
following reload; navigation never replays Submit automatically.

## Getting started

Enable this plugin in **Settings → Plugins → Manage plugins**, then open its
Review Configuration dock icon. Choose a channel and register a repository. For each lane, select
reviewer agents, enter instructions, and configure at least one routing rule, then save. Open the repository to edit settings.
These selections do not start reviews or grant agents access to the channel.

---

## Storage and access

`configuration.ts` owns the save/load boundary. Each channel/repository pair has
one deterministic NIP-AR artifact of type `buzz.review.config` (kind 45010).
The signed event's `h` tag is its review channel. Its content is:

```json
{
  "version": 1,
  "repository": "example-org/project",
  "lanes": [
    {
      "id": "general",
      "name": "General",
      "instructions": "Check authorization, error handling, and tests.",
      "reviewers": []
    }
  ],
  "reminderMinutes": 15
}
```

The existing relay artifact writer persists the current head in `artifact_heads`,
the accepted revisions in `artifact_revisions`, and the signed payload in `events`.
There is no new SQL migration or local-only settings store. Ordinary channel
authorization applies: readers can see instructions, and members who can post
can edit them. Configuration is scoped to a channel, not globally unique across
the community. No GitHub credentials are stored or requested, and repository
existence/access is checked when loading PR details for submission.

Edits carry the revision that the form loaded in `prev`; the relay rejects a
stale edit atomically. A failed or uncertain save keeps the draft. Copy any
changes before Cancel → Reload, then inspect the saved version before retrying.
An unsupported or malformed row shows a warning without hiding valid rows.
Channel metadata reconfirmation disables Save while retaining an open draft.

Opening a channel or clicking Reload makes one bounded snapshot query. Configuration reads do not poll. The first version supports
100 configurations per channel, 12 lanes per repository, and a 32 KB payload.
Larger result sets are explicitly marked incomplete; use a separate channel.
The reminder interval is saved for the planned executor but has no effect yet.

## Try it

1. Enable the plugin and open the **Review Configuration** dock icon.
2. Choose a writable stream or forum channel and click **Register repository**.
3. Enter a repository, select lane reviewers, add instructions, then **Save settings**.
4. Reload the page, choose the same channel, and verify the repository row.
5. Edit the instructions, save, and use **Reload** to confirm the new version.
6. In two clients, edit the same version; the second save must fail without
   discarding its draft after the first client saves.

Use a test channel. Saving does not activate any review automation.

Reviewer choices come from the session’s shared agent inventory. Saved public keys
remain visible and removable if an agent disappears or is archived. Unassigned
lanes may be saved as drafts. Submission requires one available reviewer per matching lane,
verified ownership by the signed-in user, and existing channel membership. The
outbox rechecks membership before publishing mentions. Agent ownership is checked
from fresh signed profiles; archive evidence and shared agent choices must be
available. Run a connected agent in the desktop app to receive replies. A browser
lab with registered identities alone cannot execute a review.

## Submissions and recovery

One `buzz.review.submission` artifact per channel/repository/PR stores the selected
reviewers, instructions, configuration revision, and message IDs. New version-2
submissions store only matching lane threads. Earlier version-1 submissions retain
their overview and original lane IDs. Explicit resubmission notifies lane reviewers
only, never the overview. Reviewer ownership and availability are revalidated;
the outbox verifies channel membership before publishing mentions.

The URL identifies the repository. Each Submit reads saved configuration fresh.
For a new submission, the reader obtains complete and consistent GitHub title,
labels, file count, paths, and base/head commits before routing. Existing submissions
reuse their snapshot without requiring a GitHub read. Reviewers must verify the
current PR and report the commit they reviewed; this does not pin their checkout.

Artifact create/CAS prevents competing initial submissions. A Web Lock serializes
operations in the same profile. Original delivery belongs to the submitting profile;
other profiles may read its links but cannot take over incomplete initial delivery.
Dispatch intent is saved before enqueue, and the durable outbox retains message
identities through interrupted saves or uncertain receipts. Missing recovery data
stops delivery instead of creating replacement threads.

Explicit notifications use a recovery key per saved lane thread in the current
identity/community's outbox. Successful receipts remain until the batch succeeds,
so retrying a partial batch does not recreate its acknowledged messages. After
completion another explicit Submit starts another notification batch. These are
user-triggered follow-ups, not an exactly-once cross-device notification guarantee.
A failed notification leaves existing thread buttons available and reports failure.

Opening Submit PR reads the latest 100 submissions once, with truncation/error
feedback. Submit reads configurations and the current submission, then verifies
reviewer profiles and ownership before dispatch. Pending agent triage also resumes
on reconnect; there is no polling. No GitHub comments or scheduled reminders are added.

Try a fresh test PR URL → Submit PR → Open a lane thread. Check its URL, reviewer
mention, and complete instructions. Submit the same URL again: the same threads
must receive follow-ups. Check unknown repositories, zero matching lanes, and
interrupted delivery. Required channel membership and connected reviewer runtimes
are separate from configuration.

## Routing rules

New or edited lanes require 1–12 rules, combined with **Match all rules** or **Match any
rule**. Earlier rule-free lanes remain readable and match every PR until edited; editing one requires adding a rule. A PR can match several lanes; zero matches
prevents submission. Title contains/does-not-contain and exact label matching
ignore case. File counts support inclusive minimum and maximum values. Paths are
case-sensitive and relative to the repository: `*` and `?` match within a path
segment, while `**` matches zero or more complete segments. `src/**/*.tsx` matches
TSX files below `src`. A negative path rule matches only when no changed path
matches. Renames use the new path.

Desktop reads use the existing signed-in GitHub CLI. Browser reads use GitHub's
public API without credentials, so private PRs and rate-limited requests need the
desktop host. The reader rejects incomplete/changing metadata and supports at
most 3,000 changed files and 100 labels; it never routes on a truncated file list.
Metadata is fetched during new submission and before continuing an admitted triage; there is no poller.


## Internal review status (POC)

Each lane starts at **Needs review**. Its assigned reviewer calls the standard
Buzz tool `pr_review_status_update` with `status: "reviewing"` first, then only `status: "request_changes"`, `status: "lgtm_not_approved"`, or
`status: "approved"`. The host supplies the review thread outside the model's
arguments; the tool resolves its current assignment and checks the reviewer.
Outcomes require a valid signed Reviewing report for the current request. A
skipped step returns the required call and posts a tagged correction, deduplicated
on retries. Reminders start a new request and require Reviewing again.
This is tool enforcement, not a new relay authorization rule.
One review is active per PR; re-reviews happen sequentially in the saved lane
threads. This POC does not bind a late call from an older turn to an older round.

**Remind** resets its selected lane to **Needs review**; resubmitting a listed PR resets all its review lanes to **Needs review** and
send updated requests in those same threads. Failed notification batches resume
from the original browser profile without replacing accepted messages. Older
submissions gain status reporting when reminded. Overall status is **Changes requested** if any lane needs changes, **Needs review** if any lane is pending, and
**Approved** only when every lane reports approved; **Looks good · not approved** when all lanes are positive but at least one has not approved. Old Done records display **Completed · outcome unspecified**. GitHub status remains separate.

Signed kind-9 status messages are both the durable report and the thread
notification. The tool and dashboard validate the assigned reviewer and current
request token. These are application checks; the generic relay enforces its
existing signature and channel-access rules. Report retries reuse the saved
status; sequential updates use a sequence number for ordering within a second.
The table applies incoming reports without polling. Reload reconciles shared
submission changes and missed reports. A full snapshot uses one artifact read
and up to twelve report reads, in batches of 100 current request tokens; capped
report pages fail visibly rather than supplying incomplete statuses.

The plugin obtains the tool's concise workflow description with
`agents.describeTool("pr_review_status_update")` when composing a request and
places it after prominent lane instructions and the approval policy. Reminder
notes appear first under **Your reminder message** as a blockquote.

Native Codex thread sessions and the shared HarnessKit provide review context.
A standalone MCP host can set `BUZZ_CHANNEL` and `BUZZ_REVIEW_THREAD` when starting
a process dedicated to that thread. Never reuse that process across threads.
Channel-wide sessions, external MCP, and adapters without this host wiring refuse
status updates. Merely including a thread ID in the prompt does not enable it.
ACP hosts must pass those variables when creating each thread session and
recreate existing sessions after adding the wiring. Updating MCP alone does not
provide review context.

## Admission checks and agent triage

Open a repository's **Admission checks** to enable any combination of:

- **Require ready for review:** reject drafts.
- **Require green CI:** require all reported commit statuses/check runs to pass;
  successful, neutral, and skipped checks count as passing. Missing or pending
  CI blocks submission. Browser reads support up to 100 statuses and 100 check runs.
- **Require no merge conflicts:** require GitHub to confirm the PR is mergeable.
  An unknown result blocks submission until GitHub finishes calculating it.
- **Enable agent triage:** select one owned agent and provide instructions, such
  as checking for duplicate PRs. **Refresh agents** updates available choices.

All checkboxes start off. Save them before editing lanes or leaving the repository.
Changes apply to new submissions; existing submissions retain their configuration.
All selected basic checks must pass before triage or reviewer threads are created.
A failure shows its reason without closing or modifying the GitHub PR.

Agent triage creates one dedicated thread and shows **Awaiting triage**. The
assigned agent calls `pr_triage_decision` with `decision: "admit"` or `"reject"`
and a nonempty `message`. Buzz supplies the target through the same trusted
thread context as review reporting; model-supplied PR/thread IDs are refused.
The request includes documentation read from the tool registry.

Admission reloads PR metadata and checks that its head and base still match the
triaged snapshot, reruns enabled basic checks, and then applies existing lane
routing. A changed snapshot is rejected; delete and resubmit for new triage.
Rejection saves the reason and triage-thread link and creates no lane threads.
A saved agent decision cannot be changed; repeated identical calls are harmless.
Transient read or delivery failures remain visible and can be retried through Submit PR.

Continuation runs while the plugin is enabled on the original submitting device,
including with its pages closed. It resumes after reconnect/restart using a local
list of at most 100 pending entries. Each entry causes one current-artifact read,
followed by a current-head/report check when work remains. Startup and reconnect
are jittered; live decisions and saved updates trigger targeted reconciliation.
No channel-wide recovery scan or polling is added. Local hints cannot authorize
routing: signed current state, submitter/device ownership, Web Locks, artifact
CAS, and the existing durable outbox are checked before sending. Keep that
browser profile; missing outbox data stops ambiguous sends. Submissions with
triage use version 4 and require clients supporting this version.


Each lane has **Allow automatic approval**, unchecked by default. When off,
request and reminder instructions explicitly forbid GitHub approval, and both
the status tool and dashboard reject an approved report. When on, the reviewer
may approve a PR that looks good, then report approved only after GitHub succeeds.
The tool records the reviewer’s report; it does not submit or independently verify
GitHub approvals. Configuration changes apply to new submissions; existing requests
keep their saved lane policy. No approval setting authorizes merging.

Reviewers must first report `reviewing` to acknowledge acceptance, including acknowledgment-only requests. Requests and reminders emphasize this step and the approval policy before lane instructions; tool-owned guidance lists the final outcomes. A chat acknowledgment alone does not change status.
