# Foundation alignment proposal

Status: ready for visual discussion; no shared defaults changed.

Run `bin/pnpm design:dev` and open
`/tests/fixtures/design-system.html#/design/foundation-alignment`.
The System navigation links to the same page. The page owns the intent mapping
and renders flat color, typography, and spacing tables next to the comparison.

## Scope

Start from the shared system integrated by PRs #9 and #24. Compose its Panel,
PanelHeader, Button, and Switch rather than importing the older component port.
Keep Inter, Tabler, the current type weights, and the host's appearance ownership.

Three independent viewer-only choices test existing vocabulary:

- Completion text: primary text or green step 12, always with a check and label.
- Reading paragraph: body or body-large. Controls, headings, and metadata keep
  their own roles.
- Space between content groups: the section-gap role or twice that distance.
  Panel inset and row spacing stay constant.

Both specimens start with the current tokens. They are synthetic compositions,
not claims about how a particular shipping project page looks. Controls change
only the proposal specimen; the Follow action changes local preview state.
Reloading resets experiment choices. The viewer's existing appearance preference
continues to work independently.

No new semantic aliases are justified by this fixture alone. After selecting a
treatment, try it on a real product surface and check its repeated uses before
changing shared defaults or proposing a new role. Keep each accepted token family
in a separate draft PR. Coordinate policy edits with PR #51, which was still a
draft when this proposal began; this branch does not include its commits.

## Reference and adaptation

The reference is a pinned BlockUI specification snapshot, not a dependency or a
claim that every draft metric is settled:

- [Type intent](https://github.com/squareup/design-blockinterface/blob/c89319ea3e11a35d58f19ba83f4d976d143e7485/blockUI/docs/type.roles.md)
- [Type resolution](https://github.com/squareup/design-blockinterface/blob/c89319ea3e11a35d58f19ba83f4d976d143e7485/blockUI/docs/type.resolution.draft.json)
- [Layout rhythm](https://github.com/squareup/design-blockinterface/blob/c89319ea3e11a35d58f19ba83f4d976d143e7485/blockUI/Design.md)

The larger reading role shares the reference's 16px default size but keeps Buzz's
Inter settings. The 32px group gap is a Buzz experiment inspired by separating
larger groups; it is not an exact translation of BlockUI's observed 64px section
gap. Status color exercises an existing Buzz ramp. No proprietary assets,
reference implementation, or full token catalogue are copied.
