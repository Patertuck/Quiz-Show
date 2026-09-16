import { publishStandby } from "../presentation-host.js";
import { DEFAULT_LOGOS } from "../game-catalog.js";
import { state } from "../store.js";

export async function mount(root, { navigate }) {
  root.querySelector(".start-logo").src = state.library?.activeLogoUrls?.main || DEFAULT_LOGOS.main;
  const button = root.querySelector(".start-continue");
  const masterButton = root.querySelector(".start-master");
  const advance = () => navigate("setup");
  const handleKeydown = (event) => {
    if (event.target === masterButton) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    advance();
  };

  await publishStandby();
  button.addEventListener("click", advance);
  masterButton.addEventListener("click", (event) => { event.stopPropagation(); navigate("master"); });
  window.addEventListener("keydown", handleKeydown);
  return () => {
    button.removeEventListener("click", advance);
    window.removeEventListener("keydown", handleKeydown);
  };
}
