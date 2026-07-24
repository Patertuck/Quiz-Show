import { saveState } from "../store.js";
import { publishStandby } from "../presentation-host.js";
import qrcode from "../../assets/vendor/qrcode.js";

export function mount(root, { navigate }) {
  const setupButton = root.querySelector("#team-setup-button");
  const audienceButton = root.querySelector("#audience-display-button");
  const buzzerButton = root.querySelector("#buzzer-join-button");
  const buzzerDialog = root.querySelector("#buzzer-dialog");
  const qrContainer = root.querySelector("#buzzer-qr");
  const buzzerUrl = root.querySelector("#buzzer-url");
  const buzzerLocalUrl = root.querySelector("#buzzer-local-url");
  publishStandby().catch(() => undefined);

  audienceButton.addEventListener("click", () => {
    const display = window.open("/display", "quiz-audience-display");
    if (!display) window.alert("The browser blocked the audience display window. Allow pop-ups and try again.");
  });

  buzzerButton.addEventListener("click", async () => {
    buzzerDialog.showModal();
    qrContainer.textContent = "Generating QR code…";
    try {
      const response = await fetch("/api/buzzer/info", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const { joinUrl, localUrl, lanAvailable } = await response.json();
      buzzerUrl.href = joinUrl;
      buzzerUrl.textContent = joinUrl;
      buzzerLocalUrl.href = localUrl;
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
      setupButton.disabled = false;
      setupButton.removeAttribute("aria-busy");
    }
  });
}
