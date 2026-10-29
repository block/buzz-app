const closeButton = document.getElementById("close-window");
const closeHint = document.getElementById("close-hint");
const spinner = document.getElementById("close-spinner");
let timer;

function closeWindow() {
  clearTimeout(timer);
  spinner.setAttribute("hidden", "");
  window.close();
  closeHint.textContent =
    "If this window stays open, close this tab using your browser.";
  closeHint.hidden = false;
}

closeButton.hidden = false;
closeButton.addEventListener("click", closeWindow);
if (document.body.dataset.complete === "true") {
  spinner.removeAttribute("hidden");
  closeHint.hidden = true;
  timer = setTimeout(
    closeWindow,
    Number(document.body.dataset.closeDelay) * 1000,
  );
}
