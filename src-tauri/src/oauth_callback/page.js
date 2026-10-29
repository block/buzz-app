const closeButton = document.getElementById("close-window");
const closeHint = document.getElementById("close-hint");
const keepButton = document.getElementById("keep-open");
let timer;

function closeWindow() {
  clearTimeout(timer);
  keepButton.hidden = true;
  window.close();
  closeHint.textContent =
    "If this window stays open, close this tab using your browser.";
}

closeButton.hidden = false;
closeButton.addEventListener("click", closeWindow);
keepButton.addEventListener("click", () => {
  clearTimeout(timer);
  keepButton.hidden = true;
  closeHint.textContent = "This window will stay open. Finish sign-in in Buzz.";
});
if (document.body.dataset.complete === "true") {
  closeButton.textContent = "Close now";
  keepButton.hidden = false;
  let seconds = Number(document.body.dataset.closeDelay);
  const countdown = () => {
    if (seconds <= 0) {
      closeWindow();
      return;
    }
    closeHint.textContent = `This window will close in ${seconds} second${seconds === 1 ? "" : "s"}.`;
    timer = setTimeout(() => {
      seconds -= 1;
      countdown();
    }, 1000);
  };
  countdown();
}
