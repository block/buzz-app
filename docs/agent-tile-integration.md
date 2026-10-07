# Thomas Petersen's shared-compute agent tile integration

This integration merges `feat/community-compute-plugin` at
`b4a910e793b60a190ba7d4ed246de321c54741c1` into the community mesh work
(`jimmy/mesh-share-wip` at `def6be26`). It preserves Thomas Petersen's original
commits, author identities and Signed-off-by trailers as merge ancestry. No
squashing, cherry-picking, author substitution or rewritten sign-offs is used.

## User-visible behavior carried forward

Thomas's `AgentsPage` and `AgentRunner` made shared-compute agents recognizable
under My agents, reported that their runner started in this app, and provided
Start/Stop with visible start failures. The current implementation adapts that
intent to the existing `AgentCard` and `ManagedAgentActions` owners:

- Each saved Buzz Agent using `relay-mesh` is labeled **Shared compute**.
- Its management controls identify the shared-compute runner and show the native
  start prerequisite while stopped.
- Start and Stop remain per-agent operations through `AgentControl`; two agents
  with the same name never share a runner control by name.
- Native failure remains visible without claiming the runner started.
- Both the unified inventory and fallback managed-agent view retain every agent,
  its profile/edit/archive actions, and normal grouping.

The existing native agent controller prepares the selected community's mesh
before starting the agent. Shared compute must first be enabled in that agent's
community. Starting an agent does not silently replace another community's node;
existing selection, consent, membership and shutdown fences are unchanged.

## Merge resolution and intentionally superseded code

The merge keeps the current mesh branch's tree as its starting resolution, then
adds the tile presentation and regression coverage above. This is a selective
integration of Thomas's tile intent, **not** a claim that the entire older compute
stack is enabled. Original source remains available at its original commits.

| Thomas branch code | Resolution / current owner |
| --- | --- |
| `AgentsPage` special first-mesh-agent article and `AgentRunner` | Adapted to standard cards and per-agent management; do not hide additional mesh agents. |
| `agent_runner_*`, dedicated Moonpal process/profile/supervisor | Superseded by existing agent controller and `src-tauri/src/mesh_compute/agent.rs`. |
| `community_compute_*`, `crates/community-compute`, compute host/consumer/worker | Superseded by `crates/mesh-compute` and `src-tauri/src/mesh_compute*`; no parallel runtime added. |
| Broker compute-status/identity routes and compute-pair packaging | Not imported; current native identity, publication and runtime packaging remain unchanged. |
| Compute settings plugin, map and sharing views | Current `src/bundled/mesh-compute` remains the settings owner. |
| Activity visualization | Restored directly from `b4a910e7` in the follow-up below; embedded in the current Shared compute page. |
| Floating native window, demo credits/wallet, extra permissions and dependencies | Not imported; no new commands, windows, wallet or dependencies. |
| Navigation, settings, relay, plugin manager, icon and native wiring | Keep current mesh branch wiring; older compute contracts are not registered. |

All six Thomas-branch commits absent from the mesh base retain their original
hashes, including the original `thomasp@block.xyc` author/sign-off on `a1bed81a`.
That existing identity is preserved, not corrected or certified on Thomas's behalf.

## Validation boundary

Colocated React tests exercise both Agents page render paths, exact-identity
Start/Stop, namesakes, failed start recovery, and provider labeling. These are
synthetic host checks, not native mesh execution or live community acceptance.
No browser journeys are added or removed. Native launch, inference/reply,
packaging and human UI acceptance remain separate checks.

## Follow-up: restore the actual animated visualization

The first merge adapted agent-card text but omitted the animated tile the human
actually meant. This follow-up restores **Thomas's actual**
`public/compute-widget.js` and HTML from `b4a910e7`, whose source blob is
`eb002cfd23298246e1ba9dcb253ad29be6e1a516`, rather than recreating its design.
The drawing functions, poses, four designs and reduced-motion behavior are reused.
Original Apache-2.0 source attribution is retained. The original source was added
in Thomas's `a1bed81a`; that commit and the later branch head already remain
ancestors through merge `590a4ab2`.

Adaptation is limited to the integration boundary:

- Embed the tile in an `allow-scripts` sandbox on Shared compute; no native IPC,
  account access, runtime ownership, dragging, or separate floating window.
- The existing page's status refresh supplies telemetry. Polling continues while
  the runtime is ready and ends when the page unmounts or the runtime stops.
- The same existing `mesh_compute_status` read projects allowlisted scalar usage.
  An accepted worker launch advances an epoch; samples cannot cross that epoch.
- Thomas's usage projection is adapted from his original Rust source. Fields are
  independently nullable. Known peers are not necessarily serving/connected peers;
  routing-observed completion tokens are not local-machine contribution, and the
  SDK throughput field is a completed-attempt average, not live decoding speed.
- Keyboard design switching is scoped to the iframe. Numeric synthetic previews
  and native dragging are disabled. Stale inputs clear counters after five seconds.
- No new dependency, IPC command, persistence record or sharing authority is added.

The donor renderer regression is restored and adapted to parent-fed status.
Existing Sharing browser coverage now also checks real canvas pixels, iframe
telemetry and design switching in Chromium and WebKit; no new browser cases were
added or removed. Rust tests cover null/partial projection and worker epochs.
Native compilation is not packaged/live acceptance; real inference and human
visual approval remain outstanding.

## Shared compute presentation

The sharing presentation now follows the supplied design: one header-level
Share compute switch, the original bee tile beside Hardware / AI memory / Model
cards, and the four activity cards above the existing community-agent and
community-mesh sections. Model selection, Auto reset, download progress, errors,
consent and shutdown recovery still use the existing Mesh owners and controls.
The layout is adapted to the app's shared design tokens and responsive widths;
it is not an import of Thomas's superseded native compute stack.

Completed requests and **Other sharing nodes** remain `—`: the current SDK
projection does not establish those quantities. Known peer counts are used only
by the visualization, not misrepresented as serving contributors. Tokens are
routing-observed session completions, not proof of this machine's contribution.
The human approved the screenshot preview; native/live inference and packaged
acceptance remain separate from that visual approval.
