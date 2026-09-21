# DESIGN.md

## Direction

Buzz adopts Block UI's visual language and semantic color grammar. Base UI
remains the behavior layer; Buzz owns styles, composition and product semantics.
Use Inter and JetBrains Mono, public dependencies and generic examples. Do not
copy private packages, proprietary fonts, internal product data or private source.

## Semantic colors

Use `color / purpose / emphasis / state`: surface, text, border and affordance.
An affordance is a control or action color. CSS spells these `--surface-panel`,
`--text-standard`, `--border-prominent` and `--affordance-subtle-hover`.
Tailwind utilities include `bg-surface-panel`, `text-standard`,
`border-prominent` and `bg-affordance-subtle-hover`. Text and border registrations
stay in separate namespaces so they cannot accidentally share a value.

Components choose roles, not palette steps. The palette is an implementation
detail, even when a role uses the same step in both themes. Add a role only for
an actual use, document it in the registry and measure its intended pairings.
Legacy utilities and host aliases remain while their callers migrate. Do not
add new uses. Whole materials such as glass still travel as one shared recipe.

| Role | Use |
| --- | --- |
| `surface-panel` | Content panels and form fields. |
| `text-standard` | Main text on a neutral surface. |
| `text-subtle` | Supporting text. |
| `border-prominent` | Field boundaries and stronger separators. |
| `affordance-subtle-hover` | Hover on a quiet action. |

## Foundations

The interface uses shared color, type, spacing and shape roles. Primary actions
are neutral. Text uses Inter for reading and labels, and JetBrains Mono for code
and identifiers. Regular (400) supports reading; Medium (500) marks labels and
structure. The Typography page documents each role’s complete setting.

Panel padding is 24px, control inset 16px, group gap 32px and page-section gap
64px at the default scale. Values are rem-based. Full-window gradient backdrops
and glass navigation support both color modes; content panels use opaque neutral
surfaces. Dark text roles are selected for contrast on their intended surfaces.
Host compatibility names resolve to the shared tokens.

Features own layout, data and behavior. The foundation guard covers `src/`,
including the Emoji Mart adapter. Layout dimensions, emoji artwork geometry and
terminal ANSI/artwork remain renderer-owned; terminal controls use shared colors
and mono type.

This guide describes how to use the system: surface relationships, hierarchy,
identity, interaction and composition. The token registry documents the available
values and their purpose.

Run `pnpm design:dev` and open `/tests/fixtures/design-system.html` to see the system rendered from the tokens themselves.

## Identity shapes

Human avatars are circular. Agent avatars are squircles. Use the shared
Avatar `shape="circle"` or `shape="squircle"`; the shape carries identity meaning,
not density or emphasis. The caller supplies identity type from domain data,
never a name or picture heuristic. `size="fill"` fills the owning layout’s
available space. Shape clips the artwork, never the interactive focus target.

## Posture

Buzz is a place where people build together and bring their agents into the room. Everyday surfaces stay quiet, crisp, and highly functional; character shows up in identity, guidance, transitions, and ceremony rather than in the chrome of ordinary work. Colour is signal, not decoration. When in doubt, the interface gets out of the way of the conversation.

## Surface and depth

- **Panels sit on the backdrop; the backdrop is a gradient.** Everything else is a panel in a different place. The navigation column is not a special kind of surface.
- **A region is separated by a soft fill, not by an outline.** Reach for `bg-inset` before reaching for a border. A bordered box announces its own edges; a filled one lets the content sit in a place. Grouping is the common case, so the quiet treatment is the default one.
- **Use border-standard for quiet separators, border-prominent for controls and border-focus for keyboard focus.** Error and warning boundaries have their own roles. Measure real surfaces in both themes.
- **No page-wide gradient behind documentation or dense reading.** The gradient is the product's backdrop for chrome and panels. Behind a column of prose it fights the text and makes contrast position-dependent — such surfaces sit on `bg-panel`.
- **Shadows stay at the threshold of perception.** If a shadow is obvious, it is too strong. The two elevation values are the whole vocabulary.
- **Elevation is carried by shadow in light mode and by lightness in dark mode.** On a near-black background there is nothing darker for a shadow to cast, so a floating surface becomes a step lighter instead. Never reach for a stronger shadow to make something float in dark mode.
- **On a translucent surface, elevation reads as less translucency, not as a lighter colour.** A glass container with a fully opaque child looks layered; the same container with a merely brighter child looks unchanged.
- **Light comes from one direction, and every glass surface agrees on it.** A glass rim is bright along the lit edge and dimmer on the opposite one; that is what makes it read as a material rather than an outline. Two surfaces lit from different directions in the same view look like a mistake.
- **A glass rim is not an outline.** If a surface needs a visible boundary rather than a material edge, it wants a border role, not glass.
- **Glass needs something behind it worth seeing.** Translucency over a flat fill is wasted cost; use it where the gradient, an image, or content actually shows through.
- **Only panels and chrome should sit directly on the gradient as a default.** Text and hairlines on a gradient have position-dependent contrast. Good practice rather than a hard rule — a rotated label pill on the backdrop is fine.
- **A translucent surface has no contrast guarantee, and this one is measured.** `check-contrast` pairs each text role with the *opaque* surface roles, so glass is invisible to it — the surface a person actually reads against is the fill composited over whatever gradient happens to be behind it, which varies by position on screen. Sampled from a rendered dark-mode screenshot, primary glass over Night garden runs from `#162e28` in its quiet regions to `#1e4a3c` where the green glow reaches through. On the darker end everything clears; on the brighter end **`text-secondary` measures Lc 58 and `text-tertiary` Lc 43**, against targets of 60 and 45. Marginal, and only in a region the glow reaches — but real, and no guard can see it. Three ways out, none obviously right: make the gradients' bright stops dimmer where panels sit, raise the glass fill a ramp step under a bright backdrop, or keep meta text off glass. **Deliberately unresolved** — it needs the real product content on screen, not a token edit.
- **A redundant fill on glass is not free — it compounds.** Two identical translucent layers are not one layer: `glass-2` over `glass-2` composites to **0.77 alpha**, a value no token holds. Four panels each set the same fill as the container they exactly covered, so panels meant to be the most translucent surface in the system read as nearly solid. Before giving a region a glass fill, check whether its parent already is glass; if the region covers it, it needs no fill of its own.
- **A component that can sit on either the gradient or a panel says so, with a variant.** `Tabs` takes `chrome` (a glass pill for the app backdrop) or `panel` (an underline for a plain surface); `IconButton` has the same axis as its `chrome` variant. The failure that earned it: the chrome container is `glass-2`, which over a white panel composites to pure white, and its selected pill is `neutral-1` — also pure white. Container and selection became one colour with only a shadow between them, and no guard could see it because the component had no way to state which background it expected. **The fix was never to retint `--bg-chrome-selected`** — that moves the collision rather than removing it. **One component with a variant, not two components:** behaviour, keyboard model, accessibility, props, and the Base UI parts underneath are identical, so a sibling component would duplicate all of it to change how selection is drawn, and the two would drift exactly as the four hand-assembled chrome surfaces did. When adding a component that could appear in both places, give it the axis and put both on its specimen page — the chrome-only specimen is why this defect survived until it appeared on a real screen.

## Controls

Button uses prominent, subtle, ghost, destructive and outline emphasis. Its
32 / 40 / 52px sizes are sm / md / lg at the default scale; labels may wrap and
increase height at larger text settings. Text buttons use pill corners. Fields
use the shared control corner. Legacy Button names map to these variants during
migration; do not add new primary/quiet or compact/default call sites.

Field groups label, input, help and error using Base UI. Input and Textarea
carry the shared field appearance. RadioGroup is for one choice, Checkbox for an
independent choice and Switch for an immediate on/off setting. Use the native
form semantics exposed by those Base UI primitives rather than duplicating them.

## State

- **Design default, hover, pressed, focus, selected, disabled and loading states where they apply.** Pressed changes fill without moving the control. Loading keeps the label footprint and prevents repeated activation; CSS alone cannot enforce it.
- **Hover means one step more contrast, in whichever direction that surface needs.** A light row darkens, a dark chip lightens. Direction lives in the value.
- **Selected is a persistent statement, not a stronger hover.** It should be legible without a cursor present.
- **A selected item in a toggle group is not interactive.** Clicking it does nothing, so it gets no hover.
- **Disabled communicates unavailability, not quietness.** It is not a fourth level of the emphasis ramp.
- **Never hide the only way out of a state.** Before adding a visibility rule, ask what happens when the state it assumes is wrong, and whether the person can still recover.

## Emphasis

- **Three levels of text: normal, lesser, really lesser.** If a fourth seems necessary, the thing wants a different size, weight, or position instead of a fourth colour.
- **Two text colours do most of the work.** Treat the third level as genuinely for metadata.
- **Borders describe their job:** a quiet edge, a control boundary or focus.
- **Weight and size carry hierarchy before colour does.** Reaching for a louder colour to fix hierarchy usually means the size relationship is wrong.

## Type

Two layers, and the same rule as colour: only roles are used when building a
screen. Layer 1 is the raw ramps (`--type-size-*`, `--type-leading-*`,
`--type-tracking-*`, `--type-weight-*`); layer 2 is the roles, which register in
Tailwind's `--text-*` namespace and become utilities like `text-body`. The
authoring lives in `src/shared/design-system/styles/typography.css`.

**Size roles and colour roles never collide**, because they live in different
namespaces: colour registers as `--color-*` and is named for emphasis
(`text-primary`), size registers as `--text-*` and is named for an editorial job
(`text-body`). So `text-primary text-body` is one colour plus one setting, and no
name ever means both.

The active sizes are 12, 14, 16, 18, 20, 24, 28, 32, 36, 44, 56, 72 and 96px
at 100% text size. Sans roles use Inter and mono roles use JetBrains Mono.
Values scale with the host text-size preference.

- Components use named roles, never private primitive sizes. The viewer shows
  each utility’s semantic role and complete setting alongside the size ladder.
- A role carries size, leading, tracking and weight together. Display roles have
  solid leading; the 24px section title uses 24/24, not the primitive's 24/32.
- Regular (400) is for reading; Medium (500) is for labels and structure.
  Existing `font-semibold` consumers resolve to Medium.
- Mono uses `detail/body-xsmall` at 12/16 with 0.03em tracking.
  `--type-xsmall-size` points to the existing 12px step, keeping the semantic
  independent from caption even though their sizes currently match. `text-mono-lg` and
  `text-mono-sm` are compatibility aliases for this same setting, not extra sizes.
- Caption uses 12/16 and 0.0133em tracking. Default reading text is 16/24.
- Preserve text preferences and browser zoom. Author values in scaled rem and
  keep layout geometry independent of text scaling.

Typography follows the adopted Block UI scale, using public fonts. The values
documented above define this system, including the 12px xsmall role.

## Both modes

- **Design in both modes, not in light and then dark.** Dark is not a filter applied afterwards: elevation, glass, and accent text all behave differently there.
- **Accent text moves in opposite directions between modes.** Darker than its fill on a light background, lighter on a dark one.
- **A tint is a pale wash in light mode and a deep one in dark.** The name describes the job, not the lightness.
- **Check the pairing, not the swatch.** A colour is only right in the context of what sits on it and behind it.
- **Every dark value in this system is authored rather than observed.** The design exploration it came from is light-only. Treat anything that looks wrong in dark as a finding.

## Density and rhythm

- **Dense data renders as rows with dividers, edge to edge.** Wrapping every list item in its own card is the most common way a functional surface becomes a marketing page.
- **Content that separates itself needs no divider, and no container.** A divider is for uniform rows where the eye needs a line to track along. When each entry already carries a visible difference — a colour swatch, a type specimen, an avatar — the content is the separator, and adding a rule or a card on top is redundant structure. Space alone is enough.
- **Never judge a value against a surface it will not be used on.** A swatch on a grey fill, or a type specimen in a tinted box, is being evaluated in a context the product will never reproduce. Samples sit on the page. The one exception is a value that needs a backdrop to exist at all — translucency needs something behind it, and a white surface swatch needs a hairline or it renders as nothing.
- **Cards are for widgets, galleries, and settings groups.** A card is a bordered, padded region on the page, not a different depth.
- **A card carries no default fill.** It sits on `bg-panel` and is grouped by a hairline or by spacing. Fill on a card is reserved for `bg-hover`, and only where the card is actually clickable — so a filled card always means *you are pointing at this*, never merely *this is a box*. This is why there is no `bg-card` role: a card with no default fill needs no name. It also rules out the cards-in-cards look, where a filled card inside a filled panel reads as a stack of empty text fields. Reaching for `bg-inset` here is the specific mistake — `inset` means pushed in, like an input or a code block, which is the opposite gesture from grouping.
- **Pick the frame before the content.** Decide what the surface is — a list, a reading column, a workspace — before filling it.
- **Whitespace is generous by default.** Crowding reads as a different product.

## Motion

- **Direct manipulation follows the pointer exactly, with no easing.** Smoothing during a drag or resize reads as lag. Spring physics belongs to what happens after release.
- **A drag gesture must not select text in whatever it passes over.**
- **Never animate blur.** Re-blurring a large surface every frame is expensive enough to feel. Animate opacity instead.
- **Motion explains a change; it does not decorate one.** If removing an animation loses no information, remove it.

## Colour structure

The palette supplies values. Semantic roles name their purpose. Components and
screens consume those roles so one shared edit can change every caller.

| Layer | Example | Used by |
|---|---|---|
| **Palette** | `--purple-9`, `--neutral-4` | Shared token definitions; each hue has authored light and dark steps. |
| **Roles** | `--surface-panel`, `--text-danger`, `--affordance-subtle-hover` | Component recipes and product screens. |
| **Components** | Button, TextField, Dialog | Product features that need the same appearance and behavior. |

Choose a role by its job, even when it uses the same palette step in both modes.
Add roles for real uses and their required states; document the intended surfaces
and paired text. Do not generate unused role families from every palette hue.
Existing palette utilities and older role names are compatibility APIs while
callers migrate, not the default for new UI. Tailwind's stock palette is removed.

### Changing a color

Change a semantic mapping when one job needs a different value. Change a palette
step when its value is wrong for all roles that share it. Measure the actual
pairings in both themes; a numbered step alone does not guarantee contrast.
For example, warning boundaries use amber-11 in light mode and amber-9 in dark,
because the lighter amber steps cannot identify a control against a light panel.

Palette values are based on Radix Colors (MIT), with authored neutral ramps and
documented adjustments in `tokens.css`. These are values, not a component or
behavior dependency. Base UI remains the component behavior layer.

### Naming and usage

Use purpose, emphasis and state: `surface-panel`, `text-subtle`, `border-danger`,
`affordance-prominent-pressed`. Text and border roles register in their own
Tailwind namespaces so a border cannot accidentally inherit a text color.

- Use `text-danger` for error text and pair it with the documented surface.
- Add a categorical role when a feature needs to distinguish identities by hue.
- Keep transparency in shared material recipes. Do not dim tokens locally.
- Author both light and dark values; do not derive one by dimming the other.
- When two roles share a decision, reference the same token rather than copying a literal.

## Contrast

Buzz judges text contrast with **APCA** (the perceptual algorithm in the WCAG 3
draft). Control and state boundaries use the separate WCAG 2 non-text ratio. Target **Lc 60** for body text, Lc 45 for large
or non-essential text. This is a deliberate position, taken with evidence, and
it is the rule a generated theme is measured against.

- **Why.** The WCAG 2 ratio underweights blue and ignores polarity, so it
  systematically recommends dark text on saturated mid-tone fills where light
  text is plainly more readable. Measured: white on `#3b82f6` scores WCAG 3.68
  (fail) but APCA Lc 69 (pass); black on the same fill scores WCAG 5.71 (pass)
  but Lc 40 — badly unreadable. Apple ships white on `#0088ff`–`#3daefc` in
  Messages at WCAG 2.4–3.5, and Tailwind, Bootstrap, and Radix all ship white
  on their primary blue below or near the WCAG threshold. Three independent
  signals agree with the eye; one number disagrees with all of them.
- **APCA is not the looser choice.** It is stricter wherever WCAG 2 is
  permissive: red on black (WCAG 5.25 pass, Lc 38 fail) and every dark-mode
  mid-grey. Adopting it tightens more pairings than it relaxes.
- **Report both.** WCAG 2 is what an audit measures and what regulators
  recognise today. Design to APCA, and know the WCAG number before shipping a
  surface that will be scanned. Where they disagree, say so in the change.
- **Constrain the fill, never degrade the text.** If neither black nor white
  carries a fill legibly, the fill is wrong — it is not a valid solid. Move the
  fill's lightness and keep the hue; do not settle for the less-bad text.
- **A paired text token is derived, not authored.** `text-on-*` is a function of
  its fill, so it is generated with the fill and never hand-set. Every hand-set
  pairing in this system has been wrong at least once.
- **One implementation of the rule.** Desktop, mobile, and web must not each
  compute their own pairing; they diverge and the same defect ships three times.
- **Size a text step against the worst surface it can land on**, not the most
  common one. `bg-float` is the lightest dark surface, so it is the binding case
  in dark mode; a step that only clears the target on `bg-inset` fails wherever
  a popover opens.
- **Dark mode is not light mode inverted.** APCA is polarity-asymmetric:
  light-on-dark needs more separation than the same WCAG ratio suggests. The
  dark ramp's text steps are therefore lighter than a mirrored ramp would put
  them — steps 9 and 10 sit above where linear spacing would.
- **`text-disabled` is deliberately below target.** Low contrast is the signal
  that a control is unavailable. Never put information a person needs there.
- **`pnpm design:check` enforces this.** Every text role is measured against
  every surface it can sit on, in both modes, parsed from `tokens.css` so the
  check cannot drift from the tokens. Exceptions live in that script with a
  stated reason, which keeps the list short and arguable.
- **A tint's hover is the hardest surface an identity has**, so a `text-*` role is
  sized against that rather than against the neutral panel. Every failure the
  audit found on a coloured surface was on a tint-hover, never at rest.
- **Hairline dividers are not held to a contrast target.** WCAG's 3:1 non-text
  rule covers boundaries needed to identify a *control* or its state, not
  grouping lines. Buzz's borders measure 1.2–1.8:1, which is where Radix and
  Apple ship theirs; raising them would draw the box the fill already implies.
  Error and warning boundary roles must reach 3:1 against surface-base,
  surface-panel, surface-inset and surface-popover in both themes. The contrast
  guard checks these role mappings separately from text and decorative dividers.

## Writing

- **Every word earns its place.** Prefer the shortest phrasing that stays accurate.
- **Labels say what happens, not what the thing is called internally.**
- **Empty states say what this place is for and what to do next.** An empty state is a first impression, not an error.
- **Errors say what happened and what to do about it.** A message the person cannot act on is decoration.

## Accessibility

- **Every interactive element has explicit assistive semantics, and one owner per label.** Two widgets claiming the same label produces duplicate screen-reader stops.
- **Contrast comes from the paired token, not from judgement.** Where a background is not neutral, its text is named for it.
- **Keyboard, pointer, and shortcut paths must not diverge.** When adding an input handler, enumerate the ways a person can reach it and check the ones that are not the mouse.
- **Focus rings are for keyboard navigation, not pointer navigation.** Gate every authored focus treatment with `html[data-keyboard-navigation]` and `:focus-visible`; the app-root input-modality owner supplies that attribute. Mouse, pen, and touch focus stays quiet, including programmatic focus during a drag. Keyboard focus remains clearly visible on the control itself.
- **Colour is never the only carrier of meaning.** Pair it with text, shape, or position.

## Responsiveness

- **Design for narrow, intermediate, and wide, not just wide.** Intermediate widths are where layouts usually break.
- **Text scales with the person's preference and with zoom.** Anything readable uses relative units; fixed pixel text freezes and breaks zoom.

## Growing the system

1. Use an existing component before assembling its appearance yourself.
2. Choose a semantic role by purpose. Add a state sibling when the actual control needs it.
3. Keep each new role paired in both modes, document it in the token registry, and check contrast.
4. Fix shared decisions in their owner. Do not cancel shared styles from a feature stylesheet.
5. Keep layout, media geometry, editor semantics and data behavior with their product owner.

## Components

- **Compose existing components freely. Never reimplement one.**
- **Focus is keyboard-only visual navigation.** Pointer focus stays quiet; keyboard navigation gives the focused control—not its container—a visible focus ring. Browsers can retain `:focus-visible` after programmatic focus too, so every component focus treatment must explicitly require `html[data-keyboard-navigation]`; do not rely on the base-layer reset to defeat a component-layer outline or shadow. Never add a `:focus-within` focus ring to a container: it duplicates the child control's signal and makes pointer focus noisy.
- **Base UI is the behavior layer.** Before writing an interactive shared component, inspect Base UI for the matching primitive. When one exists, wrap and compose it; Base UI owns focus, keyboard behavior, positioning, portals, and dismissal, while Buzz owns the visual language and product semantics. Reach for native elements only when Base UI has no matching primitive or the component is semantically static.
- **Need a variant that doesn't exist? Add it, mark it proposed.** If a variant almost fits but you would cancel several of its states, the base is wrong for the job and the system is missing a variant.
- **Never add a boolean prop for a visual difference.** Variants are enumerable, so an agent can read the list and pick; booleans multiply, and nobody designed most of the combinations. New props are for data and behaviour, not appearance.
- **Used by one feature? It lives in that feature's folder.** Used by two? Propose it as shared. The folder is the namespace.

## Using the system

- **Use an existing component before creating one, and an existing role before adding one.**
- **A new visual treatment that repeats belongs in the system, not in the feature.**
- **If a shared role fails in a real context, repair the role — never work around it locally.** A documentation specimen frame needed a border but `border-primary` was neutral-4 in both modes, which measured 1.08:1 on the dark page. The wrong response was the one we made first: name `neutral-6` directly and call documentation furniture a special case. The right response was to ask whether the one shared boundary role was wrong, measure it on every surface it reaches, and make it `neutral-4` light / `neutral-6` dark. The frame then returned to `border-primary`, and every product divider improved with it. **A local exception is evidence the shared decision is incomplete, not a licence to bypass it.**
- **Choose the job first.** Page → surface-base; card → surface-panel; popup → surface-popover; recessed region → surface-inset. Controls use affordance roles; labels use text roles; edges use border roles.
- **A role is useful because it names a purpose.** It does not need different palette steps in each theme to earn its name.
- **If a screen looks right but breaks these rules, the rules are probably wrong — say so.** This document is meant to be argued with, not worked around.

## Icons

Phosphor is the only general icon family. Import named icons from `icons/index.ts`, which re-exports individual upstream modules. Add exports as needed; no approval list. SVG-only widgets use individual assets through `icons/svg.ts`. Do not import the upstream packages elsewhere or reintroduce other icon libraries. All six native weights remain designer choices: no size-to-weight or selection-to-fill rules. For chat and conversation metaphors, prefer the rounded `ChatCircle` family (including `ChatsCircle`) over square or teardrop variants; choose the matching dots, text, or slash variant when the meaning requires it. Keep accessible names on controls and decorative artwork hidden from assistive technology.

OneDrive is a designer-approved custom brand mark: its complete outline is recreated on Phosphor’s square canvas, uses the same current-color and sizing behavior, and stays in the shared icon gateway. It does not permit another general icon library.
