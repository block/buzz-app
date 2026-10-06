// Evaluated only in the trusted main webview by the macOS Close menu.
// Return a JSON-serialized status to the native callback.
(() => {
  if (document.querySelector('dialog[open], [aria-modal="true"]'))
    return "handled";
  const request = new Event("buzz:close-active-tab", { cancelable: true });
  window.dispatchEvent(request);
  return request.defaultPrevented ? "handled" : "unhandled";
})();
