// TEMPORARY CI diagnostics for Linux WebKit drift; remove before review.
export async function recordGeometry(page) {
  await page.addInitScript(() => {
    const raf = window.requestAnimationFrame.bind(window);
    const log = [];
    window.__geo = log;
    const t0 = performance.now();
    const push = (entry) => {
      log.push([Math.round(performance.now() - t0), ...entry]);
      if (log.length > 1500) log.splice(0, 300);
    };
    const scroller = () => document.querySelector("[data-message-scroller]");
    const short = (id) => (id ? id.slice(0, 6) : "-");
    const read = (el) => {
      const b = el.getBoundingClientRect();
      const rows = [...el.querySelectorAll("[data-message-id]")];
      const view = rows.filter((r) => {
        const x = r.getBoundingClientRect();
        return x.bottom > b.top && x.top < b.bottom;
      });
      const at = (r) =>
        r
          ? `${short(r.dataset.messageId)}@${(r.getBoundingClientRect().top - b.top).toFixed(1)}`
          : "-";
      const items = el.querySelector("ol")?.children ?? [];
      let hidden = 0;
      for (const item of items)
        if (getComputedStyle(item).visibility === "hidden") hidden++;
      return [
        el.scrollTop,
        el.scrollHeight,
        el.clientHeight,
        rows.length,
        hidden,
        at(view[0]),
        at(view[1]),
        at(view.at(-1)),
        document.querySelector("[data-history-start]")?.dataset.historyStart,
      ].join(" ");
    };
    const caller = () =>
      (new Error().stack ?? "")
        .split("\n")
        .slice(2, 5)
        .map((line) => line.trim().replace(/\(.*\/([^/]+:\d+):\d+\)/, "$1"))
        .join(" < ");
    const descriptor = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "scrollTop",
    );
    Object.defineProperty(Element.prototype, "scrollTop", {
      ...descriptor,
      set(value) {
        if (this.matches?.("[data-message-scroller]"))
          push(["setTop", this.scrollTop, value, caller()]);
        descriptor.set.call(this, value);
      },
    });
    for (const name of ["scrollBy", "scrollTo"]) {
      const original = Element.prototype[name];
      Element.prototype[name] = function (...args) {
        if (this.matches?.("[data-message-scroller]"))
          push([name, this.scrollTop, JSON.stringify(args), caller()]);
        return original.apply(this, args);
      };
    }
    let last;
    let hooked;
    const frame = () => {
      const el = scroller();
      if (el) {
        if (hooked !== el) {
          hooked = el;
          push(["mount"]);
          el.addEventListener("scroll", () => push(["scroll", read(el)]));
          el.addEventListener("scrollend", () => push(["scrollend", read(el)]));
          el.addEventListener("wheel", (e) => push(["wheel", e.deltaY]), {
            passive: true,
          });
          el.addEventListener("virtua-scroll-correction", (e) =>
            push(["correct", JSON.stringify(e.detail), read(el)]),
          );
        }
        const value = read(el);
        if (value !== last) push(["frame", value]);
        last = value;
      }
      raf(frame);
    };
    raf(frame);
    window.__geoMark = (label) => {
      const el = scroller();
      push(["mark", label, el ? read(el) : ""]);
    };
  });
}

export async function mark(page, label) {
  await page.evaluate((label) => window.__geoMark?.(label), label);
}

export async function dumpGeometry(page, testInfo) {
  if (!process.env.GEO_ALWAYS && testInfo.status === testInfo.expectedStatus)
    return;
  const log = await page.evaluate(() => window.__geo ?? []).catch(() => []);
  const text = log.map((entry) => entry.join(" ")).join("\n");
  console.log(`GEO-BEGIN ${testInfo.title}\n${text}\nGEO-END`);
  await testInfo.attach("geometry.txt", {
    body: text,
    contentType: "text/plain",
  });
}
