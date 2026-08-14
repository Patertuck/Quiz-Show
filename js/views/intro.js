import { publishIntro } from "../presentation-host.js";
import { createIntroHeads } from "../intro-heads.js?v=2";

export async function mount(root, { navigate }) {
  const screen = root.querySelector("#intro-view");
  const videos = Array.from(screen.querySelectorAll("video"));
  const continueButton = screen.querySelector(".intro-continue");
  const continueLabel = continueButton.querySelector("span");
  let headsVisible = false;
  let publishingHeads = false;
  let stopHeads = () => undefined;
  const advanceIntro = async () => {
    if (publishingHeads) return;
    if (headsVisible) {
      navigate("setup");
      return;
    }
    headsVisible = true;
    stopHeads = createIntroHeads(screen);
    continueLabel.textContent = "Nochmals klicken für die Teamerstellung";
    continueButton.disabled = true;
    publishingHeads = true;
    try {
      await publishIntro(true);
    } catch (error) {
      console.error("Köpfe konnten auf der Publikumsanzeige nicht eingeblendet werden:", error);
    } finally {
      publishingHeads = false;
      continueButton.disabled = false;
    }
  };
  const handleKeydown = (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    advanceIntro();
  };

  videos.forEach((video) => video.play().catch(() => undefined));
  await publishIntro(false);
  continueButton.disabled = false;
  continueButton.addEventListener("click", advanceIntro);
  window.addEventListener("keydown", handleKeydown);

  return () => {
    stopHeads();
    window.removeEventListener("keydown", handleKeydown);
    continueButton.removeEventListener("click", advanceIntro);
    videos.forEach((video) => video.pause());
  };
}
