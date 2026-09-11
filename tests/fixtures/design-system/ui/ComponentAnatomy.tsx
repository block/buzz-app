import { useEffect, useState } from "react";

import {
  type ColorScheme,
  useColorScheme,
} from "../../../../src/shared/design-system/theme/useColorScheme";

/**
 * What a component is made of, read from the running component.
 *
 * The question this answers is "which token draws this part" — the one a specimen
 * cannot answer, because a picture of a control does not say whether that pill is
 * `bg-chrome-selected` or a hardcoded white.
 *
 * It reports the token and stops there. The value each token resolves to is the
 * token table's subject, and repeating it here made every cell two lines of which
 * only one was the answer.
 *
 * **It reads the live DOM rather than a hand-written table**, for the same reason
 * the token table does: a typed-out list of parts and tokens is a second source
 * of truth that goes stale the first time someone edits the stylesheet, and goes
 * stale silently. Here, a part whose declaration changes reports the new value on
 * the next render, and a part that stops existing reports that it is missing.
 *
 * The trade is that it can only describe what is currently on screen. That is
 * why each row names a selector: the row is a claim that this part exists, and a
 * missing part is shown as missing rather than omitted.
 */

/** A property worth reporting, and the CSS property it reads. */
const PROPERTIES = [
  { id: "background", label: "Fill", css: "background-color" },
  { id: "color", label: "Text", css: "color" },
  { id: "border", label: "Border", css: "border-color" },
  { id: "shadow", label: "Shadow", css: "box-shadow" },
  { id: "blur", label: "Blur", css: "backdrop-filter" },
  { id: "radius", label: "Radius", css: "border-radius" },
] as const;

type PropertyId = (typeof PROPERTIES)[number]["id"];

export interface AnatomyPart {
  /** What this part is, in the product's words. */
  name: string;
  /** A CSS selector for it, resolved inside the specimen root. */
  selector: string;
  /** Which properties are worth reporting for this part. */
  show: readonly PropertyId[];
  /** Why this part looks the way it does, when that is not obvious. */
  note?: string | undefined;
}

interface Measured {
  /**
   * The colour scheme these values were read in, so a stale read is visible.
   *
   * Carried on the row rather than merely listed as an effect dependency, so the
   * re-measure is a real data flow: a row states the mode it was read in.
   */
  scheme: ColorScheme;
  name: string;
  note?: string | undefined;
  present: boolean;
  /** The token each reported property is drawn from. */
  values: Partial<Record<PropertyId, string>>;
}

/**
 * Finds the declaration a rule made for a property, so the table can show
 * `var(--bg-chrome-selected)` next to the `#ffffff` it paints.
 *
 * Computed style alone cannot answer this: by the time it is readable the
 * `var()` is resolved and the token name is gone. So the stylesheets are walked
 * for the last rule that matches this element and sets this property, which is
 * the same approach `useResolvedToken` takes for tokens.
 */
function declaredValue(element: Element, property: string): string | null {
  // `background` is the shorthand an author actually writes; `border-radius` and
  // `box-shadow` are their own thing. Longhand first so the more specific
  // declaration wins when a rule sets both.
  const names =
    property === "background-color"
      ? ["background-color", "background"]
      : [property];

  let found: string | null = null;
  let bestRank = -1;
  for (const [index, rule] of styleRules().entries()) {
    let matches = false;
    try {
      matches = element.matches(rule.selector);
    } catch {
      continue; // a selector this browser cannot match
    }
    if (!matches) continue;
    for (const name of names) {
      const value = new RegExp(
        String.raw`(?:^|;)\s*${name}\s*:\s*([^;]+)`,
        "i",
      ).exec(rule.body)?.[1];
      if (!value) continue;
      // Specificity first, then source order — the actual cascade. Ranking by
      // source order alone was wrong the moment a variant rule outranked a
      // shared one: `.buzz-tabs[data-variant="panel"] .buzz-tabs-tab:not(...)`
      // beats `.buzz-tabs-tab[data-selected]`, so a selected tab was reported
      // as the unselected colour. The table looked plausible and was wrong,
      // which is the failure mode it exists to prevent.
      const rank = specificity(rule.selector) * 100000 + index;
      if (rank > bestRank) {
        bestRank = rank;
        found = value.trim();
      }
    }
  }
  return found;
}

/**
 * A selector's specificity as one comparable number.
 *
 * Only the b and c columns matter here — these are stylesheet rules on classes,
 * attributes, and pseudo-classes, with no inline styles or IDs in play. `:not()`
 * contributes its argument's specificity rather than its own, which is why it can
 * silently strengthen a rule that reads like a narrowing.
 */
function specificity(selector: string): number {
  const inner = selector.replace(/:not\(([^)]*)\)/g, " $1 ");
  const classes = (inner.match(/\.[\w-]+/g) ?? []).length;
  const attributes = (inner.match(/\[[^\]]+\]/g) ?? []).length;
  const pseudoClasses = (inner.match(/:(?!:)[\w-]+/g) ?? []).length;
  const elements = (inner.match(/(?:^|[\s>+~])[a-z][\w-]*/gi) ?? []).length;
  return (classes + attributes + pseudoClasses) * 256 + elements;
}

/**
 * Every style rule on the page, as `{ selector, body }` text.
 *
 * Development injects CSS as stylesheet text; production extracts it into a
 * linked stylesheet whose rules sit inside cascade layers. Read both forms and
 * recurse through grouping rules so the published viewer reports the same token
 * columns as development.
 *
 * Cached per page stylesheet shape, because parsing every rule for every property
 * of every part is otherwise quadratic on a page with a few tables.
 */
let ruleCache: {
  key: string;
  rules: { selector: string; body: string }[];
} | null = null;

function collectCssRules(
  source: CSSRuleList,
  output: { selector: string; body: string }[],
) {
  for (const rule of source) {
    if (rule instanceof CSSStyleRule) {
      for (const selector of rule.selectorText.split(",")) {
        output.push({ selector: selector.trim(), body: rule.style.cssText });
      }
      continue;
    }
    if ("cssRules" in rule) {
      collectCssRules((rule as CSSGroupingRule).cssRules, output);
    }
  }
}

function styleRules(): { selector: string; body: string }[] {
  const sheets = Array.from(document.styleSheets);
  const key = sheets
    .map((sheet) => `${sheet.href ?? "inline"}:${sheet.cssRules.length}`)
    .join("|");
  if (ruleCache?.key === key) return ruleCache.rules;

  const rules: { selector: string; body: string }[] = [];
  for (const sheet of sheets) {
    try {
      collectCssRules(sheet.cssRules, rules);
    } catch {
      // A future cross-origin stylesheet is not ours to document.
    }
  }
  ruleCache = { key, rules };
  return rules;
}

/**
 * `var(--bg-glass-primary)` → `bg-glass-primary`.
 *
 * The token name is the answer this table exists to give, so it is shown bare.
 * A declaration that composes several tokens — the glass rim is two inset
 * shadows — keeps its structure, because that composition *is* the answer there.
 */
function tokenNames(declared: string): string {
  const refs = [...declared.matchAll(/var\(\s*--([\w-]+)\s*\)/g)].map(
    (match) => match[1],
  );
  if (refs.length === 0) return declared;
  if (refs.length === 1 && /^var\(\s*--[\w-]+\s*\)$/.test(declared.trim())) {
    return refs[0] ?? declared;
  }
  return declared
    .replace(/var\(\s*--([\w-]+)\s*\)/g, "$1")
    .replace(/\s+/g, " ");
}

/** Values that mean "this property is not part of how the element looks". */
function isAbsent(painted: string): boolean {
  return (
    painted === "none" ||
    painted === "rgba(0, 0, 0, 0)" ||
    painted === "transparent" ||
    painted === "0px"
  );
}

export function ComponentAnatomy({
  parts,
  scope,
  caption,
}: {
  parts: readonly AnatomyPart[];
  /** A selector for the specimen this describes, so two variants can differ. */
  scope: string;
  caption?: string;
}) {
  const [rows, setRows] = useState<Measured[] | null>(null);
  // The shared colour-scheme fact. This used to be a local MutationObserver on
  // `<html>`, because `useColorScheme` held per-caller state and reading it here
  // would have produced a second answer that never heard the layout's toggle.
  // The fact now has one value, so the workaround is gone.
  const { scheme } = useColorScheme();

  useEffect(() => {
    // After paint, so Base UI has mounted and the indicator has its size.
    const frame = requestAnimationFrame(() => {
      const root = document.querySelector(scope);
      setRows(
        parts.map((part) => {
          const element = root?.querySelector(part.selector) ?? null;
          if (!element) {
            return {
              scheme,
              name: part.name,
              note: part.note,
              present: false,
              values: {},
            };
          }
          const computed = getComputedStyle(element);
          const values: Measured["values"] = {};
          for (const property of PROPERTIES) {
            if (!part.show.includes(property.id)) continue;
            // Computed style answers only "is this part of how the element
            // looks" — a transparent fill or `box-shadow: none` gets no row. The
            // reported value is the token, read from the declaration.
            if (isAbsent(computed.getPropertyValue(property.css).trim()))
              continue;
            const declared = declaredValue(element, property.css);
            if (!declared) continue;
            values[property.id] = tokenNames(declared);
          }
          return {
            scheme,
            name: part.name,
            note: part.note,
            present: true,
            values,
          };
        }),
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [parts, scope, scheme]);

  const columns = PROPERTIES.filter((property) =>
    rows?.some((row) => row.values[property.id]),
  );

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {caption ? (
        <p className="text-body-sm text-secondary">{caption}</p>
      ) : null}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-primary border-b">
              <th className="py-2 pr-6 text-body-sm text-tertiary font-normal">
                Part
              </th>
              {columns.map((property) => (
                <th
                  key={property.id}
                  className="py-2 pr-6 text-body-sm text-tertiary font-normal"
                >
                  {property.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows?.map((row) => (
              <tr key={row.name} className="border-primary border-b">
                <td className="py-3 pr-6 align-top">
                  <span className="text-body text-primary">{row.name}</span>
                  {row.note ? (
                    <span className="block text-body-sm text-tertiary">
                      {row.note}
                    </span>
                  ) : null}
                  {row.present ? null : (
                    <span className="block text-body-sm text-red-12">
                      Not found in the specimen
                    </span>
                  )}
                </td>
                {columns.map((property) => {
                  const value = row.values[property.id];
                  return (
                    <td key={property.id} className="py-3 pr-6 align-top">
                      {value ? (
                        <code className="text-mono-sm text-primary">
                          {value}
                        </code>
                      ) : (
                        <span className="text-body-sm text-tertiary">—</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
