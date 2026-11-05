(input) => {
  const { revision, request } = input;
  const ELEMENT_LIMIT = 150;
  const NAME_CHARS = 200;
  const TEXT_CHARS = 20000;
  const OPTION_LIMIT = 30;
  const CANDIDATE_LIMIT = 10000;
  const HREF_BYTES = 2048;
  const INDEX_LIMIT = 999999;
  const PAGE_PART_BYTES = 122880;
  const CANDIDATES =
    "a[href], button, input, select, textarea, [role], [contenteditable], h1, h2, h3, h4, h5, h6";
  const SKIPPED_TEXT =
    "input, textarea, select, script, style, [contenteditable]";
  const FILL_TYPES = ["text", "search", "email", "url", "tel", "number"];
  // The HTML standard's fields that block implicit submission when a form
  // has more than one and no submit button.
  const BLOCKING_TYPES = [
    "text",
    "search",
    "tel",
    "url",
    "email",
    "password",
    "date",
    "month",
    "week",
    "time",
    "datetime-local",
    "number",
  ];
  // The page can read this map. Refs guard honest pages from timing, not
  // from a hostile page, which can act on its own document anyway.
  const REFS = Symbol.for("buzz.browserControl.refs");

  const fail = (code, message) => ({ error: { code, message } });
  // WebKit hands native code this reply with each "/" escaped as "\/", so
  // the budget counts that byte too and keeps the raw reply under its cap.
  const bytes = (value) =>
    new TextEncoder().encode(JSON.stringify(value).replaceAll("/", "\\/"))
      .length;
  // serde_json rejects a lone surrogate escape, so one would fail the reply.
  const wellFormed = (value) =>
    value.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g, (match) =>
      match.length === 2 ? match : "\uFFFD",
    );
  const collapse = (value) => value.replace(/\s+/g, " ").trim();
  const cut = (value, most) => {
    const points = Array.from(value);
    return points.length > most ? points.slice(0, most).join("") : value;
  };

  const visible = (element) =>
    element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility === "visible" &&
    !element.closest('[hidden], [inert], [aria-hidden="true"]');
  // An option has no box of its own while its select is closed.
  const shown = (element) =>
    visible(
      element instanceof HTMLOptionElement
        ? (element.closest("select") ?? element)
        : element,
    );
  const disabled = (element) =>
    element.matches(":disabled") ||
    element.closest('[aria-disabled="true"]') !== null;
  const inViewport = (element) => {
    const box = element.getBoundingClientRect();
    return (
      box.bottom > 0 &&
      box.right > 0 &&
      box.top < innerHeight &&
      box.left < innerWidth
    );
  };

  const resolve = (reference) => {
    const refs = globalThis[REFS];
    const element =
      refs?.revision === revision
        ? refs.elements.get(reference)?.deref()
        : undefined;
    return element?.isConnected ? element : undefined;
  };

  const currentRefs = () => {
    if (globalThis[REFS]?.revision !== revision)
      Object.defineProperty(globalThis, REFS, {
        configurable: true,
        value: {
          revision,
          next: 1,
          refs: new WeakMap(),
          elements: new Map(),
        },
      });
    return globalThis[REFS];
  };

  /** Text of `root` outside fields, scripts, and styles, enough for a name. */
  const plainText = (root) => {
    const pieces = [];
    let units = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement?.closest(SKIPPED_TEXT)) continue;
      pieces.push(node.data);
      units += node.data.length;
      if (units > 4 * NAME_CHARS) break;
    }
    return collapse(pieces.join(" "));
  };

  const field = (element) =>
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement ||
    element.isContentEditable;

  // Names never read a value or editable content.
  const nameOf = (element) => {
    const label = collapse(element.getAttribute("aria-label") ?? "");
    if (label) return label;
    const labelledBy = (element.getAttribute("aria-labelledby") ?? "")
      .split(/\s+/)
      .map((id) => document.getElementById(id))
      .filter(Boolean)
      .map(plainText)
      .join(" ");
    if (labelledBy) return labelledBy;
    if (field(element)) {
      const labels = [...(element.labels ?? [])].map(plainText).join(" ");
      return collapse(
        labels ||
          element.getAttribute("placeholder") ||
          element.getAttribute("title") ||
          element.getAttribute("alt") ||
          "",
      );
    }
    return plainText(element) || collapse(element.getAttribute("title") ?? "");
  };

  const roleOf = (element) => {
    const explicit = (element.getAttribute("role") ?? "")
      .trim()
      .split(/\s+/)[0];
    if (
      /^[a-z]{1,32}$/.test(explicit) &&
      !["presentation", "none", "generic"].includes(explicit)
    )
      return explicit;
    const tag = element.localName;
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "input") {
      if (element.type === "checkbox" || element.type === "radio")
        return element.type;
      if (["button", "submit", "reset", "image", "file"].includes(element.type))
        return "button";
      return "textbox";
    }
    if (element.isContentEditable) return "textbox";
    return undefined;
  };

  const describe = (element, role, onScreen) => {
    const entry = {
      element,
      role,
      name: cut(wellFormed(nameOf(element)), NAME_CHARS),
      inViewport: onScreen,
    };
    const href = typeof element.href === "string" ? element.href : "";
    if (
      role === "link" &&
      /^https?:/i.test(href) &&
      new TextEncoder().encode(href).length <= HREF_BYTES
    )
      entry.href = wellFormed(href);
    if (
      element instanceof HTMLInputElement &&
      (element.type === "checkbox" || element.type === "radio")
    )
      entry.checked = element.checked;
    if (disabled(element)) entry.disabled = true;
    return entry;
  };

  const optionsOf = (select, onScreen) =>
    [...select.options].map((option) => {
      const entry = {
        element: option,
        role: "option",
        name: cut(wellFormed(collapse(option.label)), NAME_CHARS),
        inViewport: onScreen,
        checked: option.selected,
      };
      if (option.matches(":disabled")) entry.disabled = true;
      return entry;
    });

  const textOf = (viewportOnly) => {
    const root = document.body ?? document.documentElement;
    if (!root) return "";
    const places = new Map();
    const placeOf = (element) => {
      if (!places.has(element))
        places.set(
          element,
          !visible(element)
            ? undefined
            : inViewport(element)
              ? "first"
              : viewportOnly
                ? undefined
                : "rest",
        );
      return places.get(element);
    };
    const blocks = new Map();
    const blockOf = (element) => {
      if (!blocks.has(element)) {
        let block = element;
        while (
          block.parentElement &&
          /^(inline|contents)/.test(getComputedStyle(block).display)
        )
          block = block.parentElement;
        blocks.set(element, block);
      }
      return blocks.get(element);
    };
    const lists = {
      first: { pieces: [], units: 0, block: undefined },
      rest: { pieces: [], units: 0, block: undefined },
    };
    // A code point takes at most two code units, so past this a list
    // already holds more than the text cap.
    const room = 2 * TEXT_CHARS;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (lists.first.units > room) break;
      const value = collapse(node.data);
      const parent = node.parentElement;
      if (!value || !parent || parent.closest(SKIPPED_TEXT)) continue;
      const place = placeOf(parent);
      if (!place || lists[place].units > room) continue;
      const list = lists[place];
      const block = blockOf(parent);
      if (list.pieces.length) {
        list.pieces.push(list.block === block ? " " : "\n");
        list.units += 1;
      }
      list.block = block;
      list.pieces.push(value);
      list.units += value.length;
    }
    return wellFormed(
      [lists.first.pieces.join(""), lists.rest.pieces.join("")]
        .filter(Boolean)
        .join("\n"),
    );
  };

  const observe = (scope) => {
    const viewportOnly = scope === "viewport";
    const refs = currentRefs();
    const all = document.querySelectorAll(CANDIDATES);
    let truncated = all.length > CANDIDATE_LIMIT;
    const first = [];
    const rest = [];
    for (const element of [...all].slice(0, CANDIDATE_LIMIT)) {
      if (!visible(element)) continue;
      const role = roleOf(element);
      if (!role) continue;
      const onScreen = inViewport(element);
      if (viewportOnly && !onScreen) continue;
      const list = onScreen ? first : rest;
      list.push(describe(element, role, onScreen));
      if (element instanceof HTMLSelectElement) {
        const options = optionsOf(element, onScreen);
        if (options.length > OPTION_LIMIT) truncated = true;
        list.push(...options.slice(0, OPTION_LIMIT));
      }
    }
    const candidates = [...first, ...rest];
    if (candidates.length > ELEMENT_LIMIT) truncated = true;

    const listed = [];
    let next = refs.next;
    for (const entry of candidates.slice(0, ELEMENT_LIMIT)) {
      let reference = refs.refs.get(entry.element);
      if (!reference) {
        if (next > INDEX_LIMIT) {
          truncated = true;
          continue;
        }
        reference = `r${revision}e${next++}`;
        entry.fresh = true;
      }
      const { element, fresh, ...fields } = entry;
      listed.push({ element, fresh, json: { ref: reference, ...fields } });
    }

    const fullText = textOf(viewportOnly);
    const text = cut(fullText, TEXT_CHARS);
    if (text !== fullText) truncated = true;
    let size = bytes({ text, elements: [], truncated: true });
    let kept = 0;
    for (const entry of listed) {
      const grown = size + bytes(entry.json) + (kept ? 1 : 0);
      if (grown > PAGE_PART_BYTES) break;
      size = grown;
      kept++;
    }
    if (kept < listed.length) truncated = true;
    for (const { element, fresh, json } of listed.slice(0, kept)) {
      if (!fresh) continue;
      refs.refs.set(element, json.ref);
      refs.elements.set(json.ref, new WeakRef(element));
      refs.next += 1;
    }
    return {
      text,
      elements: listed.slice(0, kept).map(({ json }) => json),
      truncated,
    };
  };

  /** The element a ref names, or the failure its action reports. */
  const target = (reference) => {
    const element = resolve(reference);
    if (!element)
      return {
        failure: fail(
          "stale_ref",
          "The page changed after that ref was issued.",
        ),
      };
    if (!shown(element))
      return {
        failure: fail("not_interactable", "The element is not visible."),
      };
    if (disabled(element))
      return { failure: fail("not_interactable", "The element is disabled.") };
    return { element };
  };

  const click = ({ ref }) => {
    const { element, failure } = target(ref);
    if (failure) return failure;
    if (element instanceof HTMLOptionElement)
      return fail(
        "not_interactable",
        "Use select with the option's value or label to choose an option.",
      );
    if (element instanceof HTMLInputElement && element.type === "file")
      return fail("unsupported_input", "File uploads are not supported.");
    element.focus({ preventScroll: true });
    if (element instanceof HTMLElement) element.click();
    else
      element.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          view: window,
        }),
      );
    return { ok: true };
  };

  const fill = ({ ref, text }) => {
    const { element, failure } = target(ref);
    if (failure) return failure;
    const textField =
      element instanceof HTMLTextAreaElement ||
      (element instanceof HTMLInputElement &&
        FILL_TYPES.includes(element.type));
    if (!textField)
      return fail(
        "unsupported_input",
        "fill works only on text, search, email, url, tel, and number inputs and on textareas.",
      );
    if (element.readOnly)
      return fail("not_interactable", "The field is read-only.");
    element.focus({ preventScroll: true });
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, text);
    if (element.value !== text)
      return fail("unsupported_input", "The field does not accept that text.");
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true };
  };

  const select = ({ ref, value }) => {
    const { element, failure } = target(ref);
    if (failure) return failure;
    if (!(element instanceof HTMLSelectElement))
      return fail(
        "unsupported_input",
        "select works only on a select element.",
      );
    const options = [...element.options];
    const match =
      options.find((option) => option.value === value) ??
      options.find((option) => option.label.trim() === value);
    if (!match)
      return fail("invalid_request", "No option has that value or label.");
    // A value names one option whatever the page disabled, so a disabled
    // match fails rather than falling through to a later enabled option.
    if (match.matches(":disabled"))
      return fail("not_interactable", "That option is disabled.");
    element.focus({ preventScroll: true });
    for (const option of options) option.selected = option === match;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true };
  };

  const submitButton = (element) =>
    (element instanceof HTMLButtonElement && element.type === "submit") ||
    (element instanceof HTMLInputElement &&
      (element.type === "submit" || element.type === "image"));

  // HTML "implicit submission". form.elements leaves out image buttons, so
  // the default button is found by form owner over the whole document.
  const submitImplicitly = (form) => {
    const defaultButton = [...document.querySelectorAll("button, input")].find(
      (element) => element.form === form && submitButton(element),
    );
    if (defaultButton) {
      if (!defaultButton.matches(":disabled")) defaultButton.click();
      return;
    }
    const blocking = [...form.elements].filter(
      (element) =>
        element instanceof HTMLInputElement &&
        BLOCKING_TYPES.includes(element.type),
    );
    if (blocking.length === 1) form.requestSubmit();
  };

  const tabbable = (element) =>
    element.tabIndex >= 0 &&
    !(element.matches(":disabled") || element.closest("[inert]")) &&
    visible(element);

  const focusNext = (current) => {
    const order = [...document.querySelectorAll("*")]
      .filter(tabbable)
      .map((element, position) => ({ element, position }))
      .sort(
        (a, b) =>
          (a.element.tabIndex || Infinity) - (b.element.tabIndex || Infinity) ||
          a.position - b.position,
      )
      .map(({ element }) => element);
    const next = order[order.indexOf(current) + 1] ?? order[0];
    next?.focus();
  };

  // WebKit runs no default action for script events, so Enter and Tab get
  // emulated ones. Every other key, and Enter elsewhere, sends events only.
  const emulate = (element, key) => {
    if (key === "Tab") return focusNext(element);
    if (key !== "Enter") return;
    if (
      element instanceof HTMLButtonElement ||
      (element instanceof HTMLInputElement &&
        ["submit", "reset", "button", "image"].includes(element.type)) ||
      (element instanceof HTMLAnchorElement && element.hasAttribute("href"))
    )
      return element.click();
    if (
      element instanceof HTMLInputElement &&
      FILL_TYPES.includes(element.type) &&
      element.form
    )
      submitImplicitly(element.form);
  };

  const press = ({ key }) => {
    const element = document.activeElement ?? document.body;
    const init = { key, bubbles: true, cancelable: true, composed: true };
    // Browsers send keypress only for keys that produce a character.
    const proceed =
      element.dispatchEvent(new KeyboardEvent("keydown", init)) &&
      (key !== "Enter" ||
        element.dispatchEvent(new KeyboardEvent("keypress", init)));
    if (proceed) emulate(element, key);
    element.dispatchEvent(new KeyboardEvent("keyup", init));
    return { ok: true };
  };

  const scrollable = (element) =>
    /^(auto|scroll|overlay)$/.test(getComputedStyle(element).overflowY) &&
    element.scrollHeight > element.clientHeight;

  const scroll = ({ direction, ref }) => {
    if (ref !== undefined) {
      const element = resolve(ref);
      if (!element)
        return fail("stale_ref", "The page changed after that ref was issued.");
      if (!shown(element))
        return fail("not_interactable", "The element is not visible.");
      element.scrollIntoView({
        block: "center",
        inline: "nearest",
        behavior: "instant",
      });
      return { ok: true };
    }
    let container = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    while (container && !scrollable(container))
      container = container.parentElement;
    container ??= document.scrollingElement ?? document.documentElement;
    container.scrollBy({
      top: (direction === "down" ? 1 : -1) * container.clientHeight,
      behavior: "instant",
    });
    return { ok: true };
  };

  // Waiting is for an element to become usable, so it never fails as not_interactable.
  const waitFor = ({ for: condition }) => {
    const element = resolve(condition.ref);
    if (!element)
      return fail("stale_ref", "The page changed after that ref was issued.");
    return { met: shown(element) && !disabled(element) };
  };

  // The Enter step of fill with submit runs only in the document that holds
  // the filled ref, and it never creates or resets a ref map.
  if (input.fillRef !== undefined) {
    if (!resolve(input.fillRef)) return { skipped: true };
    press(request);
    return { skipped: false };
  }
  if (request.action === "observe") return observe(request.scope);
  if (request.action === "click") return click(request);
  if (request.action === "fill") return fill(request);
  if (request.action === "wait") return waitFor(request);
  if (request.action === "select") return select(request);
  if (request.action === "press") return press(request);
  if (request.action === "scroll") return scroll(request);
  return fail("invalid_request", `Unknown action ${request.action}.`);
};
