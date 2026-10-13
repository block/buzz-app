// Evaluated only in the trusted main webview by the macOS Show Next/Previous
// Tab menu items. Native code binds `tabEvent` to the event name to dispatch.
(() => {
  if (document.querySelector('dialog[open], [aria-modal="true"]')) return;
  window.dispatchEvent(new Event(tabEvent, { cancelable: true }));
})();
