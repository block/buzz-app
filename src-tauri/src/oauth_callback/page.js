const closeButton = document.getElementById("close-window");
const closeHint = document.getElementById("close-hint");

function closeWindow() {
  window.close();
  closeHint.textContent =
    "If this window stays open, close this tab using your browser.";
}

closeButton.hidden = false;
closeButton.addEventListener("click", closeWindow);
if (document.body.dataset.complete === "true") closeWindow();
