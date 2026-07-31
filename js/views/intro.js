import { publishIntro } from "../presentation-host.js";

export function mount(root, { navigate }) {
  publishIntro().catch(() => undefined);
  const screen = root.querySelector("#intro-view");
  const videos = Array.from(screen.querySelectorAll("video"));
  const continueToHub = () => navigate("hub");
  const handleKeydown = (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    continueToHub();
  };

  screen.querySelector(".intro-continue").addEventListener("click", continueToHub);
  window.addEventListener("keydown", handleKeydown);
  videos.forEach((video) => video.play().catch(() => undefined));

  return () => {
    window.removeEventListener("keydown", handleKeydown);
    videos.forEach((video) => video.pause());
  };
}
