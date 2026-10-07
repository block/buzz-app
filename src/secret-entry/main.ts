// App-owned credential entry. The value goes from this field straight to the
// native store; it never reaches the main window, where plugin code runs.
import { invoke } from "@tauri-apps/api/core";

type EntryPrompt = { pluginName: string; label: string };

const form = document.getElementById("entry") as HTMLFormElement;
const prompt = document.getElementById("prompt") as HTMLParagraphElement;
const label = document.getElementById("label") as HTMLLabelElement;
const input = document.getElementById("value") as HTMLInputElement;
const error = document.getElementById("error") as HTMLParagraphElement;
const save = document.getElementById("save") as HTMLButtonElement;
const cancel = document.getElementById("cancel") as HTMLButtonElement;

const message = (cause: unknown) =>
  typeof cause === "string" ? cause : "Could not save the credential.";

const cancelEntry = () => void invoke("plugin_secret_entry_cancel");

invoke<EntryPrompt>("plugin_secret_entry_prompt").then(
  ({ pluginName, label: name }) => {
    prompt.textContent = `“${pluginName}” asks you to save a credential. Plugins can use it but cannot read it.`;
    label.textContent = name;
    save.disabled = false;
    input.focus();
  },
  (cause) => {
    prompt.textContent = message(cause);
  },
);

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (save.disabled) return;
  save.disabled = true;
  error.textContent = "";
  invoke("plugin_secret_entry_submit", { value: input.value }).catch(
    (cause) => {
      error.textContent = message(cause);
      save.disabled = false;
    },
  );
});
cancel.addEventListener("click", cancelEntry);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") cancelEntry();
});
