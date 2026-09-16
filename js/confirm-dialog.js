const dialog = document.querySelector("#confirmation-dialog");
const titleElement = document.querySelector("#confirmation-dialog-title");
const messageElement = document.querySelector("#confirmation-dialog-message");
const cancelButton = document.querySelector("#confirmation-dialog-cancel");
const confirmButton = document.querySelector("#confirmation-dialog-confirm");

export function confirmAction({
  title,
  message,
  confirmLabel,
  cancelLabel = "Abbrechen"
}) {
  titleElement.textContent = title;
  messageElement.textContent = message;
  confirmButton.textContent = confirmLabel;
  cancelButton.textContent = cancelLabel;
  dialog.returnValue = "";
  dialog.showModal();
  cancelButton.focus();
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true });
  });
}
