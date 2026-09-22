# Product UI catalogue

Run `bin/pnpm product:dev`, then open http://localhost:1444/tests/fixtures/product-ui.html#/design/product-ui/composer.

This combined catalogue reuses the design viewer shell and routes, adding an explicit Composer entry under Product UI. `mountViewer` accepts one optional component, not a registration framework. The standalone `design:dev` / `design:build` entry never imports product code and retains its build-enforced boundary.

Composer specimens stay beside the bundled Composer and render its real editor. Workshop and catalogue share `ComposerSpecimens`; neither injects a relay. Sends are simulated and drafts reset on navigation. The catalogue owns its appearance toggle. Workshop remains available pending human parity review.

## Page hierarchy

The Composer pages are the template for every future product-UI page. Three
levels, no more; each level is told apart by type role and spacing, never by a
louder colour. The classes live in
`src/bundled/composer/lab/specimens.css` (product-owned, because neither the
design system nor its standalone viewer may import product code).

| Level | Type role | What it is |
| --- | --- | --- |
| 1 — page | `text-title` + `text-body-lg text-secondary` intro | One per page: the surface being documented |
| 2 — section | `text-heading` + `text-body text-secondary` | A group of specimens, e.g. Playground, States |
| 3 — specimen | `text-body font-semibold` + `text-body-sm text-tertiary` | One named state or variant |

Level 2 and level 3 are the pair that used to collide: both were `text-heading`,
so nothing read as a level. They are now separated by size, weight, and text
colour together, using DESIGN.md § Type's rule that a heading is body text in a
different weight — level 3 borrows that relationship one size down rather than
adding a tenth type role. A specimen description is metadata about the specimen,
so it takes `text-tertiary`; a section description is read, so it stays
`text-secondary`.

Spacing, all from the six-step scale — no ad-hoc values:

- **Title to its own description: `--space-1`.** A title and its description are
  one thing. This is the tightest gap on the page and it is what makes them read
  as a pair rather than as two stacked paragraphs.
- **Heading block to its content: `--space-6` at section level, `--space-3` at
  specimen level.** The specimen's own composer sits close to the words that name
  it.
- **Between sibling specimens: `--space-6`.** The widest step in the scale, so
  each state reads as one block instead of running into the next.
- **Between sections: `--space-6` plus a `--border-primary` hairline above.** This
  is the only rule on the page. A section boundary is a genuine boundary; a
  specimen boundary is not, and gets space alone (DESIGN.md § Density and rhythm).
- **No cards, no fills.** Each specimen already carries a visible difference — a
  live composer — so it is its own separator. The one framed surface is the
  playground stage, which exists because the composer needs a panel behind it.

Descriptions cap at `42rem` so a wide viewport does not produce a measure nobody
can read. Everything is grid-based with `min-width: 0`, so narrow and
intermediate widths hold without horizontal scroll.

`bin/pnpm product:build` builds the combined catalogue separately. Browser coverage is in `tests/browser/product-ui.spec.mjs`. Further product entries should establish actual reuse before generalizing this seam.
