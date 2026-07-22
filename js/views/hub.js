import { saveState } from "../store.js";

export function mount(root, { navigate }) {
  const setupButton = root.querySelector("#team-setup-button");

  setupButton.addEventListener("click", async () => {
    setupButton.disabled = true;
    setupButton.setAttribute("aria-busy", "true");
    try {
      await saveState();
      navigate("setup");
    } catch (error) {
      window.alert(`Could not save the current game: ${error.message}`);
      setupButton.disabled = false;
      setupButton.removeAttribute("aria-busy");
    }
  });
}
