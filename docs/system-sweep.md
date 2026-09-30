# Color, surface, and relative sizing sweep

Implementation on `am-system-sweep`, based on `origin/main` at `f778cb40`.
The changes reuse the shared palette, semantic roles, typography, components,
and standalone design viewer. They add no application state, persistence,
theme provider, or dependency. The FOUNDATION compatibility tokens are unchanged.

## Try the two playgrounds

Run `bin/pnpm design:dev --host 127.0.0.1 --port 1462 --open false` from this
worktree if the preview is no longer running.

- [Colors & surfaces](http://localhost:1462/tests/fixtures/design-system.html#/design/surface-playground): compare real buttons, inputs, checkboxes, navigation rows, and menus on base, panel, inset, and floating backgrounds. Toggle the theme and the gradient backdrop. Hover a row, select another, and open its menu to compare temporary highlighting with persistent selection.
- [Rem & text sizing](http://localhost:1462/tests/fixtures/design-system.html#/design/rem-playground): type into the field, change root size, then change text scale. The rem ruler should grow only with the root; the draft should survive both changes. Try the narrow column and navigate away: temporary sizing should reset.

## Color findings and changes

The user authorized changing the palette. Severity below describes the original
finding; the listed fixes are implemented. Changed colors use the existing sRGB
hex notation and are in gamut. Both theme blocks were inspected.

| Severity | Location | Before | After | Why |
| --- | --- | --- | --- | --- |
| MEDIUM | `src/shared/design-system/styles/tokens.css:127`, `:230`, `:305`; `scripts/design-system/check-contrast.mjs:78` | Link colors needed eight APCA exemptions. Small light metadata passed the metadata APCA target but missed WCAG AA on the darkest supported neutral fill. | Light link `#0b5fa8`, dark link `#83c4ff`, light metadata `#5f5f5f`; all link exemptions removed. The guard checks both WCAG 4.5:1 and the existing APCA targets, including hover surfaces. | Contrast belongs to the rendered text/background pair, including interaction states. Small metadata needs a normal-text ratio. |
| MEDIUM | `src/shared/design-system/styles/tokens.css:173` | White on dark accent hover `#9a5cd0` cleared APCA but missed 4.5:1. | The same hue family at `#975acc` clears 4.5:1; a regression test catches APCA-only acceptance. | A perceptual pass alone does not establish WCAG AA. |
| MEDIUM | `src/shared/design-system/styles/tokens.css:394`, `:537`, `:587`; `src/bundled/channels/Channels.module.css:39` | Dark popup and subtle control shared `#333333`; floating hover jumped to `#595959`. The sidebar aliased selection to the control fill. | Dark panel `#1a1a1a`, control `#232323`, popup `#282828`, control hover `#2e2e2e`, floating hover and selection `#333333`. Light control hover is `#f1f1f2`; floating hover is `#f5f5f6`. Sidebar selection keeps its independent role. | Each layer must separate from its parent while leaving room for controls above it. Hover remains quiet and selection remains distinct. |

Borders and decorative separators retain their existing subtle values. The
contrast guard still applies its non-text target to the supported control/state
boundaries; it does not impose that target on decorative hover fills.

### Measured contrast

Values were computed using the repository's contrast implementation. APCA values
are absolute Lc. The required WCAG ratio for these text pairs is 4.5:1.

| Pair | Before WCAG | After WCAG | After APCA |
| --- | ---: | ---: | ---: |
| Light link on pressed neutral `#dadada` | 3.409 | 4.670 | 60.113 |
| Light metadata on pressed neutral `#dadada` | 4.107 | 4.568 | 60.111 |
| Dark link on selected `#333333` | 6.010 | 6.802 | 61.785 |
| White on dark accent hover | 4.361 | 4.516 | 76.455 |

Computed foreground and background styles were also read from rendered standard,
supporting, and metadata text on all four playground surfaces in both themes.
The lowest sampled light ratio was **5.861:1** (metadata on inset); the lowest
dark ratio was **5.915:1** (metadata on floating). Screenshots were inspected in
both themes; the browser tests capture 390, 900, and 1440 CSS-pixel widths.

These measurements do not establish full application accessibility. Existing
approved light Away badge exceptions remain below the non-text target, disabled
text remains excluded, and existing hidden focus outlines are unchanged. Contrast
over arbitrary images or translucent materials is **Not verified**.

## Typography findings and changes

| Severity | Location | Before | After | Why |
| --- | --- | --- | --- | --- |
| HIGH | `src/features/messages/Messages.module.css:180`, `:211`, `:238`, `:245` | Reaction chip, emoji, and count geometry used fixed heights/leading; a 24px count could be cropped by its 14px motion wrapper at 200% text scale. | Minimum chip height, unitless leading, and a `1lh` count wrapper preserve the default size and grow with text. | Text resizing must not hide content. The real reaction fixture is covered in both engines. |
| MEDIUM | Relative-unit inventory below; `src/shared/design-system/styles/overlays.css:237`, `:285` | Authored spacing, dimensions, and independent responsive breakpoints mixed fixed px with the existing rem system. | Equivalent rem values at a 16px root for the inspected UI; runtime-coupled geometry remains physical. | Layout dimensions respond to root-size preferences without changing the host's separate text-only zoom contract. |
| LOW | `src/shared/design-system/styles/typography.css:44`, `:48`, `:52`; `src/shared/design-system/tokens/registry.ts`; `tests/fixtures/design-system/ui/TypographyPage.tsx` | Display, title, and heading roles had solid `1` leading. | Unitless `1.1` leading, documented in the registry and viewer. | Wrapped headings need separation between lines while retaining their existing size, weight, and hierarchy. |

Rendered role measurements at the default root were display **56px / 61.6px,
weight 400**, title **32px / 35.2px, weight 500**, and heading **24px / 26.4px,
weight 500** (size / line-height). The descending hierarchy is preserved.

### Relative-unit inventory

Locations identify the start of each affected module's changes; multiple related
declarations in that module were converted. This is the inspected conversion
scope, not a claim that all pixel values in the repository should disappear.

| Owner | Locations |
| --- | --- |
| App shell/settings | `src/app/NotificationSettings.module.css:69`; `src/app/startup.css:24`; `src/shared/styles/globals.css:189` |
| Channels | `src/bundled/channels/ChannelLifecycleDialog.module.css:8`; `src/bundled/channels/ChannelMembersDialog.tsx:349`; `src/bundled/channels/ChannelSidebarRow.module.css:58`; `src/bundled/channels/Channels.module.css:24` |
| Bundled panels | `src/bundled/agent-activity/ActivityAccessory.module.css:11`; `src/bundled/agents/AgentControls.css:3`; `src/bundled/emoji/Emoji.module.css:5`; `src/bundled/github/GitHub.module.css:33`; `src/bundled/link-lab/LinkLab.module.css:2`; `src/bundled/projects/projects.css:87`; `src/bundled/sessions/SessionsWorkspace.module.css:3`; `src/bundled/todos/Todos.module.css:27`; `src/bundled/workflows/workflows.css:227` |
| Conversation/messages | `src/features/conversation/Completions.module.css:14`; `src/features/conversation/LinkPreview.module.css:3`; `src/features/direct-messages/NewMessage.module.css:23`; `src/features/messages/ComposerFormattingTools.module.css:31`; `src/features/messages/Messages.module.css:49`; `src/features/messages/VideoPlayer.module.css:23` |
| Other feature surfaces | `src/features/browser/BrowserHostView.module.css:57`; `src/features/communities/Communities.module.css:28`; `src/features/panels/Panels.module.css:36`; `src/features/profiles/AvatarEditor.tsx:82`; `src/features/sessions/Sessions.module.css:39`; `src/features/user-status/Status.module.css:22` |

Intentionally retained px: hairlines and border strokes, small optical nudges,
animation/media coordinates, scrollbar masking, the timeline's 56px leading
region paired with Virtua, the 360px unknown-image fallback paired with image
measurement code, persisted sidebar widths/resize limits, and the 650px shell
navigation breakpoint paired with `matchMedia`. The playground also includes an
intentional 160px comparison ruler. Browser media-query rem units follow the
browser's initial font size; changing the playground's inline root size exercises
rem geometry and container queries, not that initial media-query setting.

## Verification and remaining checks

The validation below covers the implementation on base `f778cb40`, using pinned Hermit tools.
The independent agent review approved the inspected implementation at 9/10 after
restoring the runtime-coupled dimensions above.

| Check | Result |
| --- | --- |
| `bin/pnpm typecheck`, `bin/pnpm design:typecheck` | Passed |
| `bin/pnpm build`, then `bin/pnpm design:build` | Passed |
| `bin/pnpm design:check` | Passed; existing exceptions remain explicitly reported |
| `bin/pnpm design:test` | 110 tests passed across 17 files |
| Focused `contrast.test.mjs` / `src/shared/theme/tokens.test.ts` | 25 / 4 tests passed |
| `system-sweep.spec.ts`, design viewer Playwright config | 6 executions passed: 3 cases in Chromium and WebKit |
| Actual-app `appearance.spec.mjs` | All 12 executions passed after updating the expected popup color |
| Actual-app `design-system.spec.mjs` and `shortcuts.spec.mjs` | All 14 executions passed across Chromium and WebKit; covers live text-size changes and draft preservation |
| Changed-file Biome checks and `git diff --check` | Passed |

**Browser coverage added: 3 cases; removed: 0.** The new cases establish real CSS
cascade/hover and portalled-menu paint, independent rem/text geometry plus cleanup,
and production reaction-count layout. Those boundaries cannot be proved by a DOM
emulator; palette matrices stay in the lower-layer guard tests. The reaction
assertion was manually demonstrated failing with the old 14px wrapper and
passing at its new 28px rendered height for a 24px count.

Both engines exercise native button hover. Chromium exercises menu pointer
highlighting; WebKit exercises menu keyboard highlighting because its automation
events reported zero `movementX/Y`, which Base UI deliberately ignores. WebKit
menu highlighting with a physical pointer is **Not verified**.

The existing full viewer suite, full browser suite, native builds/device checks,
live relay, and hosted CI are **Not verified**. Human visual review is pending;
this work is ready to try, not attested ready to merge. At very large sizes, inspect
real message/media content and native window behavior before integrating the sweep.

The worktree is bootstrapped. Its existing global hooks are preserved, with
worktree-only wrappers chaining the repository's required commit and push checks.
Other worktrees and the global hook configuration are unchanged.

**Approve** for the inspected color and typography changes. No unresolved HIGH
finding remains within that scope; the verification limits above still apply.
