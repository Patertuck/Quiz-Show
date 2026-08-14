import { publishWarmupQuestion } from "../presentation-host.js";
import { scheduleTextFit } from "../fit-text.js";

const QUESTIONS = [
  { text: "Nenne so viele Taylor-Swift-Songs wie möglich." },
  { text: "Was besagt Artikel 7 der Schweizer Bundesverfassung?" },
  { text: "Nella serie televisiva Friends, ogni volta che Phoebe va dal dentista, pensa che qualcuno che conosce morirà. Vero o falso?" },
  { text: "Nenne so viele Gondelbahnmarken wie möglich." },
  { text: "Benenne folgende Krankheiten an einem menschlichen Penis.", concealedImageCount: 3 }
];

export async function mount(root, { navigate }) {
  const screen = root.querySelector("#warmup-view");
  const question = screen.querySelector(".warmup-question");
  const concealedImages = screen.querySelector(".warmup-concealed-images");
  const button = screen.querySelector(".warmup-continue");
  const buttonLabel = button.querySelector("span");
  let questionIndex = 0;
  let busy = false;

  const render = async () => {
    const current = QUESTIONS[questionIndex];
    question.textContent = current.text;
    concealedImages.replaceChildren();
    concealedImages.hidden = !current.concealedImageCount;
    for (let index = 0; index < (current.concealedImageCount || 0); index += 1) {
      const placeholder = document.createElement("div");
      placeholder.className = "warmup-concealed-image";
      placeholder.setAttribute("role", "img");
      placeholder.setAttribute("aria-label", `Verdecktes Bild ${index + 1}`);
      placeholder.innerHTML = `<strong>?</strong><span>Bild ${index + 1} verdeckt</span>`;
      concealedImages.append(placeholder);
    }
    scheduleTextFit(screen, ".warmup-question");
    buttonLabel.textContent = questionIndex === QUESTIONS.length - 1
      ? "Nochmals klicken für die Spielauswahl"
      : "Klicken für die nächste Frage";
    await publishWarmupQuestion(
      questionIndex, QUESTIONS.length, current.text, current.concealedImageCount || 0
    );
  };

  const advance = async () => {
    if (busy) return;
    if (questionIndex === QUESTIONS.length - 1) {
      busy = true;
      navigate("hub");
      return;
    }
    busy = true;
    button.disabled = true;
    questionIndex += 1;
    try {
      await render();
    } catch (error) {
      console.error("Frage konnte nicht angezeigt werden:", error);
    } finally {
      busy = false;
      button.disabled = false;
    }
  };

  const handleKeydown = (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    advance();
  };
  const handleResize = () => scheduleTextFit(screen, ".warmup-question");

  await render();
  button.disabled = false;
  button.addEventListener("click", advance);
  window.addEventListener("keydown", handleKeydown);
  window.addEventListener("resize", handleResize);

  return () => {
    button.removeEventListener("click", advance);
    window.removeEventListener("keydown", handleKeydown);
    window.removeEventListener("resize", handleResize);
  };
}
