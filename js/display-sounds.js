const definitions = {
  buzzer: ["assets/Sounds/buzzer.mp3?v=2", 0.8, false],
  pointsPositive: ["assets/Sounds/points-positive.mp3", 0.55, false],
  pointsNegative: ["assets/Sounds/points-negative.mp3", 0.55, false],
  drumroll: ["assets/Sounds/drumroll-loop.mp3?v=1", 0.5, true],
  winnerCheer: ["assets/Sounds/winner-cheer.mp3", 0.75, false]
};

const musicDefinitions = {
  ambient: ["assets/Sounds/gameshow-ambient.mp3?v=1", 0.12],
  tension: ["assets/Sounds/Buzzer_music.mp3?v=1", 0.18]
};

const sounds = Object.fromEntries(Object.entries(definitions).map(([name, [src, volume, loop]]) => {
  const audio = new Audio(src);
  audio.preload = "auto";
  audio.volume = volume;
  audio.loop = loop;
  return [name, audio];
}));

const music = Object.fromEntries(Object.entries(musicDefinitions).map(([name, [src, volume]]) => {
  const audio = new Audio(src);
  audio.preload = "auto";
  audio.volume = 0;
  audio.loop = true;
  return [name, { audio, volume }];
}));

let blockedHandler = () => undefined;
let buzzerStopTimer;
let duckRestoreTimer;
let fadeFrame;
let fadeGeneration = 0;
let soundsEnabled = false;
let desiredMusicMode = "silent";
let musicDuck = 1;
const MUSIC_FADE_MS = 600;

function reportFailure(error) {
  if (error?.name === "AbortError") return;
  console.warn("Display sound could not be played:", error);
  blockedHandler(error);
}

function playFromStart(audio) {
  if (!soundsEnabled) return Promise.resolve();
  audio.currentTime = 0;
  return audio.play().catch(reportFailure);
}

function musicTarget(name, mode = desiredMusicMode) {
  return soundsEnabled && name === mode ? music[name].volume * musicDuck : 0;
}

function stopMusicTrack(track) {
  track.audio.pause();
  track.audio.currentTime = 0;
  track.audio.volume = 0;
}

function fadeMusic(mode, immediate = false) {
  desiredMusicMode = mode in music ? mode : "silent";
  const generation = ++fadeGeneration;
  cancelAnimationFrame(fadeFrame);
  const startedAt = performance.now();
  const starts = Object.fromEntries(Object.entries(music).map(([name, track]) => [name, track.audio.volume]));
  const target = music[desiredMusicMode];
  if (soundsEnabled && target?.audio.paused) {
    target.audio.currentTime = 0;
    target.audio.play().catch(reportFailure);
  }
  const duration = immediate ? 0 : MUSIC_FADE_MS;
  const step = (now) => {
    if (generation !== fadeGeneration) return;
    const progress = duration ? Math.min(1, (now - startedAt) / duration) : 1;
    Object.entries(music).forEach(([name, track]) => {
      track.audio.volume = starts[name] + ((musicTarget(name) - starts[name]) * progress);
    });
    if (progress < 1) {
      fadeFrame = requestAnimationFrame(step);
      return;
    }
    Object.entries(music).forEach(([name, track]) => {
      if (!soundsEnabled || name !== desiredMusicMode) stopMusicTrack(track);
    });
  };
  step(startedAt);
}

function duckMusic(duration = 1000) {
  if (!soundsEnabled || desiredMusicMode === "silent") return;
  clearTimeout(duckRestoreTimer);
  musicDuck = 0.28;
  fadeMusic(desiredMusicMode);
  duckRestoreTimer = setTimeout(() => {
    musicDuck = 1;
    fadeMusic(desiredMusicMode);
  }, duration);
}

export function setDisplaySoundBlockedHandler(handler) {
  blockedHandler = typeof handler === "function" ? handler : () => undefined;
}

export function unlockDisplaySounds() {
  const audioElements = [...Object.values(sounds), ...Object.values(music).map(({ audio }) => audio)];
  const unlocks = audioElements.map(async (audio) => {
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

export function setDisplaySoundsEnabled(enabled) {
  soundsEnabled = Boolean(enabled);
  if (!soundsEnabled) {
    clearTimeout(buzzerStopTimer);
    clearTimeout(duckRestoreTimer);
    musicDuck = 1;
    Object.values(sounds).forEach((audio) => {
      audio.pause();
      audio.currentTime = 0;
    });
    fadeMusic("silent", true);
    return;
  }
  fadeMusic(desiredMusicMode);
}

export function syncBackgroundMusic(mode, immediate = false) {
  fadeMusic(mode, immediate);
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
  ? (duckMusic(1100), playFromStart(points < 0 ? sounds.pointsNegative : sounds.pointsPositive))
  : Promise.resolve();

export function startVictoryDrumroll() {
  if (!soundsEnabled) return Promise.resolve();
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
