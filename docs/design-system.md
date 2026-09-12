# Design system and appearance

> **The design system going forward:** the imported system is documented in
> [the handoff README](../src/shared/design-system/README.md) and displayed at
> `/tests/fixtures/design-system.html`. New UI and existing surfaces moving off the
> current styles should use it. This initial port does not migrate existing surfaces,
> so the host styling described below still governs those callers until they move;
> the host remains the single owner of appearance throughout the transition.

The **host** owns appearance, including startup and recovery. A plugin must not be
required to render the shell correctly. Pages still own their layout and behavior;
this is shared styling, not a second component registry or a parallel `core/` tree.

## First release contract

Settings → Appearance offers **Light** and **Dark**, defaulting to Light. The choice
is device-local (`buzz-appearance.v1` in browser-origin localStorage), not a community
profile or relay event. There is no System mode, theme marketplace or appearance sync
between devices. Another same-origin window observes saved changes without rebuilding
pages or relay services. Failed storage reads open safely in Light; failed saves apply
for this session and expose a retry in Appearance. Invalid stored values use Light.

`public/appearance-init.js` runs as a parser-blocking same-origin script in the HTML
head, before the React bundle. It sets `data-color-mode` on `<html>`; CSS supplies the
palette and `color-scheme`. It requires no unsafe-inline script CSP exception. Its
storage key/parser is intentionally tiny and checked against the service in tests.
`src/shared/theme/service.ts` owns live state, storage events, DOM application and
browser theme-color metadata. `app/services.ts` owns its lifetime, including disposal.
The built-in palettes do not fetch anything or wait for plugin/relay startup.

Native window decorations and pre-WebView launch color are **not** controlled by a
CSS attribute. An attended packaged-app check is still needed before claiming native
chrome/relaunch parity; no broad Tauri capability or CSP expansion was added here.

## Tokens are the shared contract

`src/shared/styles/tokens.css` is the only built-in color palette. Both modes define
every paint role. `globals.css` exposes the roles through Tailwind 4, base elements,
and small shared component classes. CSS modules and Tailwind use the same values.

| Roles | Use |
| --- | --- |
| `--workspace`, `--shell-image`, `--shell-dot` | App canvas and decorative shell art |
| `--surface`, `--surface-elevated` | Card and dialog/popover surfaces |
| `--surface-accent`, `--surface-control`, `--surface-input`, `--surface-hover` | Subtle, control, input and hover fills |
| `--text`, `--text-muted` | Primary and secondary text; do not lower text opacity to simulate muted text |
| `--border`, `--border-input`, `--focus` | Decorative separators, visible input boundaries, keyboard focus |
| `--primary` / `--on-primary`, `--action` / `--on-action` | Primary controls and the lavender composer action |
| `--selected` / `--on-selected` | Selected controls; also expose selection semantically |
| `--link`, `--danger`, `--warning`, `--success` | Meaningful foregrounds; pair status fills intentionally and include readable copy |
| `--overlay`, `--elevation-*` | Backdrops and card/popover/dialog/dock shadows |
| `--radius-card`, `--radius-card-compact`, `--radius-control` | Shared curvature; Tailwind `rounded-3xl` / `rounded-xl` map to card/control |

Existing `ink`, `muted`, `line`, `soft`, `shell` utilities remain compatible. New
`surface`, `elevated`, `primary`, `on-primary`, `input-line`, `focus`, `overlay` and
status utilities avoid literal palette colors. **Legacy `--accent` is a foreground**;
do not reinterpret it as shadcn's accent background. If adding shadcn components,
map their paired roles explicitly. No shadcn/Radix dependency was needed for this
slice: native radios, buttons, fields and the existing dialogs supply the behavior.

Typography uses the shared Inter/system sans stack with Tailwind's existing type
scale: `text-sm` controls, `text-base` body/labels, `text-lg` section headings and
`text-3xl` page headings. Existing conversation type sizes remain unchanged at 100%. Spacing
uses Tailwind's 4px rhythm; preserve established responsive card gutters. Avoid
creating new scales for the same values. Motion is optional and respects reduced
motion; theme changes must not fade through the old mode's foreground/background.
Existing shell/panel layering stays local to its owner; native modal dialogs use
the browser top layer, not ever-increasing global z-index values.

## Shared UI rules

- `.ui-card` is the shared surface recipe; `.ui-choice` is a labeled native-radio
  selection with hover, selected and focus-within states. The existing `.notice`,
  `.error`, `.danger`, `.actions` and shell classes use the same palette.
- Defaults/hover/focus/disabled come from base rules. Domain-specific components own
  pressed/busy/error behavior. Disabled controls must not act; busy guards are not
  replaced by CSS. A selected style must agree with ARIA (`aria-current="page"`
  requires `aria-[current=page]:`, not Tailwind's boolean `aria-current:` variant).
- Shared React components should be extracted for actual repeated behavior, not
  empty wrappers around every native element. Do not migrate all dialogs merely to
  add a component-library badge. Use an accessible headless primitive when the next
  complex interaction warrants one, and test keyboard/focus behavior in context.
- Do not invert images. Media/brand art retains its colors. All host-owned surfaces,
  including loading/recovery, must inherit the mode. CSS variables inherit into
  portals and shadow hosts; third-party Shadow DOM/canvas widgets may additionally
  require an explicit mode adapter. Theme mode changes must not reset widget input.
- `/tests/fixtures/design-system.html` now hosts the design system this app is
  moving to, with its own components, tokens and documentation. It uses no relay
  or identity services. The earlier offline diagnostic at that URL — one
  Appearance section, some native controls, profile fields and a conversation
  row — was replaced by it. The rules above still govern the styling that ships
  today; verify those in the running app and its browser journeys. Surfaces move
  onto the new system incrementally, and its documentation is the reference for
  anything already on it.

## Future theme contributions (design boundary, not implemented API)

A theme's identity is separate from its `light | dark` color mode. Future first-party
or plugin definitions can contribute named, versioned semantic values; the host owns
validation, explicit user selection, applying/removing overrides and a built-in
fallback when a contribution disappears. Do not make feature components branch on
specific theme names. Do not advertise internal source imports as a versioned SDK.
Add a supported contribution API only with its first real external consumer and
unload/rollback tests. Trusted same-process plugins can already execute arbitrary
code; these authoring conventions are not a sandbox or CSS security boundary.

## Evidence and remaining validation

`shared/theme/service.test.ts` checks parser/bootstrap agreement, denied storage,
save/retry/restore, events and disposal. `tokens.test.ts` checks complete paint roles
and selected WCAG AA token pairs. These calculations are **not** a full rendered
accessibility audit (transparency, images and focus placement need inspection).

`tests/browser/appearance.spec.mjs` exercises the production frontend with fixture
relay data in Chromium and WebKit: Settings controls, reload, denied save/retry,
cross-window updates preserving a live draft/DOM/scroll anchor, responsive screenshots,
and the dark document while the entire application JS bundle is withheld. Existing
Settings journeys also cover the added navigation stop. No live relay writes occur.

Emoji Mart uses the root mode and an in-place attribute observer, disposed with the
picker. Browser regressions cover host Settings changes through an open widget,
opening in Dark, and no updates after disposal. Mutation probes exercise the startup
script, Settings writes/retry, host lifetime and widget initial/update/disposal paths.

The initial integration batch passed the theme/picker journeys in both browsers,
Node/Vitest/plugin-manager tests, formatting/types, build and Clippy. The broad browser
run was **89/90**, not green: WebKit's `initial-position.spec.mjs` reload case reported
a localhost access-control console warning. The identical failure reproduced on
pre-theme `742a770` (one failure, two passes); its cause is not diagnosed or suppressed.
Native Rust test targets compile but contain zero tests. Human light/dark visual
approval and independent source review do not replace attended packaged-app
chrome/relaunch acceptance. Browser evidence also does not cover third-party plugins
that hard-code their own colors.


## Text size and shortcuts

The host owns a separate device-local `buzz-font-scale.v1` preference (80–200%,
10% steps; default/reset 100%). Color-mode storage is unchanged. Settings →
Appearance supplies visible decrease/increase/reset controls and save-failure retry.
The bootstrap and appearance service apply `--buzz-text-scale`; invalid persisted
values fall back to 100%, and same-origin storage events re-read the latest choice.

Command+, opens Settings on Apple platforms. Command+= / Command++ increase text,
Command+- decreases and Command+0 resets. Other platforms use Control. Zoom works
while typing and in dialogs without changing browser/WebView zoom; Settings does
not navigate behind an open modal. The [shortcut service](plugin-architecture.md#in-app-keyboard-shortcuts)
also serves plugins and owns event dispatch/lifetime rules.

Only typography scales: root rem size, layout spacing, icons and native window
geometry stay unchanged. Shared Tailwind type utilities and built-in fixed-size
CSS typography consume the scale. Plugin text can inherit host typography or use
`font-size: calc(15px * var(--buzz-text-scale, 1))`; avoid multiplying inherited
font size by the scale again. Use unitless or scaled line-height so enlarged text
does not overlap. Independent plugins that hard-code sizes and third-party shadow
widgets need their own adapter; this is not a forced CSS rewrite of arbitrary code.

`tests/browser/shortcuts.spec.mjs` covers real key dispatch to Settings and actual
message/composer text, draft/node preservation, reset/limits/reload, modal/editor/
Shadow DOM guards, and the independent example's disable/re-enable path. These
Chromium/WebKit checks use a fixture broker, not native menu accelerators. An
attended desktop shortcut try remains necessary for native acceptance.

## Incremental system integration

The host entry `src/shared/styles/globals.css` now loads the shared system's
palette, typography roles, materials and component styles with one Tailwind reset.
It does not import the viewer's global entry, preference owner, docking vendor CSS
or workspace experiments. Panel styling remains defined only by the shared system.

Existing screens retain their palette, canvas, type sizes and native-control
recipes. Compatibility names are temporary, not the vocabulary for new work.
`bg-primary` retains the old action fill via an explicit compatibility utility;
`text-primary` and `border-primary` belong to the system. The old control radius
is explicitly named `--radius-legacy-control` to avoid overriding shared controls.
Legacy monospace utilities and native code retain their system font stack; migrated
boundaries select the shared mono face. No old paint role is aliased merely because it sounds similar: the current
palettes differ, and aliasing them would silently recolor unmigrated screens.

Shared primitives carry `data-buzz-ui`, including portal popup roots. Legacy
native-element selectors exclude that boundary and its descendants (without native CSS scope); shared typography starts there.
For new custom compositions use the same boundary and named type roles, not old
native-element styling. Inline chips deliberately inherit their sentence's type.
Do not nest legacy UI inside a migrated boundary without explicitly migrating it.
This boundary does not imply a Panel, padding, scrolling or page lifecycle.

The host's existing `data-color-mode` drives shared dark tokens directly, and
`--buzz-text-scale` feeds the type ramp once. Root size and layout geometry do not
scale. Startup bootstrap, preferences, recovery, cross-window events and theme-color
remain owned by the existing appearance service. The viewer retains its separate
preference and full-document typography; its settings do not change the host.
BentoWorkspace still uses the viewer preference helper and is not ready for app
adoption; no workspace experiment is imported by app startup.

The host mounts the shared input-modality hook once, including cleanup. Shared
keyboard focus remains visible; pointer focus does not acquire a ring.

The actual-app Appearance/shortcuts journeys cover startup, preferences, focus,
and the temporary font/color compatibility contracts. Remove compatibility checks
as their legacy consumers disappear; no separate legacy viewer or test suite is
needed. Browser checks do not establish native or packaged acceptance. Broad scan
remains an agreed integration-batch gate.
