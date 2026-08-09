import { publishIntro } from "../presentation-host.js";

export async function mount(root, { navigate }) {
  const screen = root.querySelector("#intro-view");
  const videos = Array.from(screen.querySelectorAll("video"));
  const continueButton = screen.querySelector(".intro-continue");
  const continueToHub = () => navigate("setup");
  const handleKeydown = (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    continueToHub();
  };

  videos.forEach((video) => video.play().catch(() => undefined));
  await publishIntro();
  continueButton.disabled = false;
  continueButton.addEventListener("click", continueToHub);
  window.addEventListener("keydown", handleKeydown);

  return () => {
    window.removeEventListener("keydown", handleKeydown);
    continueButton.removeEventListener("click", continueToHub);
    videos.forEach((video) => video.pause());
  };
}
