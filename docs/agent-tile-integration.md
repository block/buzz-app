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
| Activity widget, demo credits/wallet, extra permissions and dependencies | Not part of this tile integration; no new commands, windows, wallet or dependencies. |
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
