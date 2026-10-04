// Keep the SVG's first frame tied to the parser-created loader, before React runs.
const launch = document.getElementById("buzz-launch");
const mark = launch?.querySelector("img");
if (launch && mark) {
  const loaded = () => {
    launch.dataset.startedAt = String(performance.now());
  };
  const failed = () => {
    launch.dataset.failed = "true";
  };
  if (mark.complete) {
    if (mark.naturalWidth) loaded();
    else failed();
  } else {
    mark.addEventListener("load", loaded, { once: true });
    mark.addEventListener("error", failed, { once: true });
  }
}
