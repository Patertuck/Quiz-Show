const definitions = {
  buzzer: ["assets/Sounds/buzzer.mp3?v=2", 0.8, false],
  pointsPositive: ["assets/Sounds/points-positive.mp3", 0.55, false],
  pointsNegative: ["assets/Sounds/points-negative.mp3", 0.55, false],
  drumroll: ["assets/Sounds/drumroll-loop.mp3?v=1", 0.5, true],
  winnerCheer: ["assets/Sounds/winner-cheer.mp3", 0.75, false]
};

const sounds = Object.fromEntries(Object.entries(definitions).map(([name, [src, volume, loop]]) => {
  const audio = new Audio(src);
  audio.preload = "auto";
  audio.volume = volume;
  audio.loop = loop;
  return [name, audio];
}));

let blockedHandler = () => undefined;
let buzzerStopTimer;

function reportFailure(error) {
  if (error?.name === "AbortError") return;
  console.warn("Display sound could not be played:", error);
  blockedHandler(error);
}

function playFromStart(audio) {
  audio.currentTime = 0;
  return audio.play().catch(reportFailure);
}

export function setDisplaySoundBlockedHandler(handler) {
  blockedHandler = typeof handler === "function" ? handler : () => undefined;
}

export function unlockDisplaySounds() {
  const unlocks = Object.values(sounds).map(async (audio) => {
    const wasMuted = audio.muted;
    audio.muted = true;
    try {
      await audio.play();
      audio.pause();
      audio.currentTime = 0;
    } finally {
      audio.muted = wasMuted;
    }
  });
  return Promise.allSettled(unlocks);
}

export function playBuzzerSound() {
  clearTimeout(buzzerStopTimer);
  const playback = playFromStart(sounds.buzzer);
  buzzerStopTimer = setTimeout(() => {
    sounds.buzzer.pause();
    sounds.buzzer.currentTime = 0;
  }, 1100);
  return playback;
}
export const playPointSound = (points) => points
  ? playFromStart(points < 0 ? sounds.pointsNegative : sounds.pointsPositive)
  : Promise.resolve();

export function startVictoryDrumroll() {
  if (!sounds.drumroll.paused) return Promise.resolve();
  return playFromStart(sounds.drumroll);
}

export function stopVictoryDrumroll() {
  sounds.drumroll.pause();
  sounds.drumroll.currentTime = 0;
}

export const playWinnerCheer = () => playFromStart(sounds.winnerCheer);

export function stopVictorySounds() {
  stopVictoryDrumroll();
  sounds.winnerCheer.pause();
  sounds.winnerCheer.currentTime = 0;
}
