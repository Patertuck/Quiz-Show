import { publishStandby } from "../presentation-host.js";

export async function mount(root, { navigate }) {
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
