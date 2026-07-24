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
    if (!display) window.alert("Der Browser hat das Fenster der Publikumsansicht blockiert. Erlaubt Pop-ups und versucht es erneut.");
  });

  playerButton.addEventListener("click", async () => {
    playerDialog.showModal();
    qrContainer.textContent = "QR-Code wird erstellt…";
    try {
      const response = await fetch("/api/buzzer/info", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const { joinUrl, localUrl, lanAvailable } = await response.json();
      playerUrl.href = joinUrl;
      playerUrl.textContent = joinUrl;
      playerLocalUrl.href = localUrl;
      if (!lanAvailable) {
        qrContainer.textContent = "Es wurde keine Adresse im lokalen Netzwerk gefunden. Setzt QUIZ_HOST_IP auf die WLAN-IPv4-Adresse dieses Computers und startet den Server neu.";
        return;
      }
      const code = qrcode(0, "M");
      code.addData(joinUrl);
      code.make();
      qrContainer.innerHTML = code.createSvgTag({ cellSize: 8, margin: 16, scalable: true, title: "QR-Code für Quizspieler" });
    } catch (error) {
      qrContainer.textContent = `Der QR-Code konnte nicht erstellt werden: ${error.message}`;
    }
  });

  setupButton.addEventListener("click", async () => {
    setupButton.disabled = true;
    setupButton.setAttribute("aria-busy", "true");
    try {
      await saveState();
      navigate("setup");
    } catch (error) {
      window.alert(`Das aktuelle Spiel konnte nicht gespeichert werden: ${error.message}`);
    } finally {
      setupButton.disabled = false;
      setupButton.removeAttribute("aria-busy");
    }
  });
}
