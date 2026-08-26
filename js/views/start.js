import { publishStandby } from "../presentation-host.js";

export async function mount(root, { navigate }) {
  const button = root.querySelector(".start-continue");
  const advance = () => navigate("setup");
  const handleKeydown = (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    advance();
  };

  await publishStandby();
  button.addEventListener("click", advance);
  window.addEventListener("keydown", handleKeydown);
  return () => {
    button.removeEventListener("click", advance);
    window.removeEventListener("keydown", handleKeydown);
  };
}
