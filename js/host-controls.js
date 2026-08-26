import { saveState } from "./store.js";
import qrcode from "../assets/vendor/qrcode.js";
import { getDisplayAudioSettings, setDisplayAudioSettings, setJoinOverlay } from "./presentation-host.js";

export function initializeHostControls({ navigate, requestEndGame }) {
  const controls = document.querySelector("#host-controls");
  const optionsButton = document.querySelector("#host-options-button");
  const optionItems = document.querySelector(".host-option-items");
  const setupButton = document.querySelector("#team-setup-button");
  const audienceButton = document.querySelector("#audience-display-button");
  const playerButton = document.querySelector("#buzzer-join-button");
  const playerDialog = document.querySelector("#buzzer-dialog");
  const qrContainer = document.querySelector("#buzzer-qr");
  const playerUrl = document.querySelector("#buzzer-url");
  const playerLocalUrl = document.querySelector("#buzzer-local-url");
  const displayRow = document.querySelector("#buzzer-display-row");
  const displayUrl = document.querySelector("#buzzer-display-url");
  const instructions = document.querySelector("#buzzer-dialog-instructions");
  const note = document.querySelector("#buzzer-dialog-note");
  const audioButton = document.querySelector("#audio-settings-button");
  const endGameButton = document.querySelector("#end-game-button");
  const audioDialog = document.querySelector("#audio-settings-dialog");
  const audioStatus = document.querySelector("#audio-settings-status");
  const audioInputs = {
    effectsEnabled: document.querySelector("#audio-effects-enabled"),
    tensionMusicEnabled: document.querySelector("#audio-tension-enabled"),
    ambientMusicEnabled: document.querySelector("#audio-ambient-enabled")
  };
  let audioUpdateChain = Promise.resolve();

  const setOptionsOpen = (open) => {
    controls.classList.toggle("is-open", open);
    optionsButton.setAttribute("aria-expanded", String(open));
  };
  optionsButton.addEventListener("click", () => setOptionsOpen(!controls.classList.contains("is-open")));
  optionItems.addEventListener("click", () => setOptionsOpen(false));
  document.addEventListener("pointerdown", (event) => {
    if (!controls.contains(event.target)) setOptionsOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      setOptionsOpen(false);
      optionsButton.blur();
    }
  });

  const readAudioInputs = () => Object.fromEntries(
    Object.entries(audioInputs).map(([key, input]) => [key, input.checked])
  );
  const updateAudioButton = (settings = readAudioInputs()) => {
    const disabledCount = Object.values(settings).filter((enabled) => !enabled).length;
    audioButton.classList.toggle("partially-muted", disabledCount > 0);
    audioButton.title = disabledCount ? `Display-Audio · ${disabledCount} deaktiviert` : "Display-Audio";
    audioButton.setAttribute("aria-label", audioButton.title);
  };
  const initialAudioSettings = getDisplayAudioSettings();
  Object.entries(audioInputs).forEach(([key, input]) => {
    input.checked = initialAudioSettings[key];
    input.addEventListener("change", () => {
      const settings = readAudioInputs();
      updateAudioButton(settings);
      audioStatus.textContent = "Wird übernommen …";
      audioUpdateChain = audioUpdateChain.catch(() => undefined).then(() => setDisplayAudioSettings(settings)).then(() => {
        audioStatus.textContent = "Einstellung übernommen.";
      }).catch((error) => {
        console.error("Could not update display audio settings:", error);
        audioStatus.textContent = `Display nicht erreichbar: ${error.message}`;
      });
    });
  });
  updateAudioButton(initialAudioSettings);
  audioButton.addEventListener("click", () => {
    audioStatus.textContent = "";
    audioDialog.showModal();
  });

  audienceButton.addEventListener("click", () => {
    const display = window.open("/display", "quiz-audience-display");
    if (!display) window.alert("Der Browser hat das Fenster der Publikumsansicht blockiert. Erlaubt Pop-ups und versucht es erneut.");
  });

  endGameButton.addEventListener("click", requestEndGame);

  playerButton.addEventListener("click", async () => {
    playerDialog.showModal();
    qrContainer.textContent = "QR-Code wird erstellt…";
    try {
      const response = await fetch("/api/buzzer/info", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const { mode, joinUrl, displayUrl: remoteDisplayUrl, localUrl, lanAvailable } = await response.json();
      playerUrl.href = joinUrl;
      playerUrl.textContent = joinUrl;
      playerLocalUrl.href = localUrl;
      displayUrl.href = remoteDisplayUrl;
      displayUrl.textContent = remoteDisplayUrl;
      displayRow.hidden = mode !== "public";
      instructions.textContent = mode === "public"
        ? "Scannt diesen Code für den Buzzer und die Handyspiele. Der Link funktioniert über WLAN und Mobilfunk."
        : "Verbindet euch mit demselben WLAN und scannt diesen Code für den Buzzer und die Handyspiele.";
      note.textContent = mode === "public"
        ? "Der Link ist nur für diese Sitzung bestimmt. Wer ihn kennt, kann dem Spiel beitreten."
        : "Falls sich die Seite nicht öffnet, erlaubt Python den Zugriff durch die Windows-Firewall und prüft, ob das WLAN die Kommunikation zwischen Geräten zulässt.";
      if (mode !== "public" && !lanAvailable) {
        qrContainer.textContent = "Es wurde keine Adresse im lokalen Netzwerk gefunden. Setzt QUIZ_HOST_IP auf die WLAN-IPv4-Adresse dieses Computers und startet den Server neu.";
        return;
      }
      const code = qrcode(0, "M");
      code.addData(joinUrl);
      code.make();
      qrContainer.innerHTML = code.createSvgTag({ cellSize: 8, margin: 16, scalable: true, title: "QR-Code für Quizspieler" });
      if (playerDialog.open) await setJoinOverlay(joinUrl);
    } catch (error) {
      qrContainer.textContent = `Der QR-Code konnte nicht erstellt werden: ${error.message}`;
    }
  });
  playerDialog.addEventListener("close", () => {
    setJoinOverlay().catch((error) => console.error("Could not hide QR code on audience display:", error));
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
