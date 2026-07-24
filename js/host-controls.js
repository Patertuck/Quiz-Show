import { saveState } from "./store.js";
import qrcode from "../assets/vendor/qrcode.js";

export function initializeHostControls({ navigate }) {
  const setupButton = document.querySelector("#team-setup-button");
  const audienceButton = document.querySelector("#audience-display-button");
  const playerButton = document.querySelector("#buzzer-join-button");
  const playerDialog = document.querySelector("#buzzer-dialog");
  const qrContainer = document.querySelector("#buzzer-qr");
  const playerUrl = document.querySelector("#buzzer-url");
  const playerLocalUrl = document.querySelector("#buzzer-local-url");

  audienceButton.addEventListener("click", () => {
    const display = window.open("/display", "quiz-audience-display");
    if (!display) window.alert("The browser blocked the audience display window. Allow pop-ups and try again.");
  });

  playerButton.addEventListener("click", async () => {
    playerDialog.showModal();
    qrContainer.textContent = "Generating QR code…";
    try {
      const response = await fetch("/api/buzzer/info", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const { joinUrl, localUrl, lanAvailable } = await response.json();
      playerUrl.href = joinUrl;
      playerUrl.textContent = joinUrl;
      playerLocalUrl.href = localUrl;
      if (!lanAvailable) {
        qrContainer.textContent = "No local-network address was detected. Set QUIZ_HOST_IP to this computer's Wi-Fi IPv4 address and restart the server.";
        return;
      }
      const code = qrcode(0, "M");
      code.addData(joinUrl);
      code.make();
      qrContainer.innerHTML = code.createSvgTag({ cellSize: 8, margin: 16, scalable: true, title: "Quiz player QR code" });
    } catch (error) {
      qrContainer.textContent = `Could not create the QR code: ${error.message}`;
    }
  });

  setupButton.addEventListener("click", async () => {
    setupButton.disabled = true;
    setupButton.setAttribute("aria-busy", "true");
    try {
      await saveState();
      navigate("setup");
    } catch (error) {
      window.alert(`Could not save the current game: ${error.message}`);
    } finally {
      setupButton.disabled = false;
      setupButton.removeAttribute("aria-busy");
    }
  });
}
