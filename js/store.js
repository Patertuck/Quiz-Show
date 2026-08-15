export const state = {
  config: null,
  configFingerprint: "",
  teams: [],
  usedTiles: new Set(),
  activeValue: 0,
  activeQuestion: null,
  gameStarted: false,
  savedState: null,
  saveChain: Promise.resolve(),
  revision: 0,
  appliedAwards: new Set(),
  scoreHistory: []
};

function requireString(value, path) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${path} muss eine nicht leere Zeichenfolge sein.`);
}

function validateImage(image, path) {
  if (image === undefined) return;
  if (!image || typeof image !== "object" || Array.isArray(image)) throw new Error(`${path} muss ein Objekt sein.`);
  requireString(image.src, `${path}.src`);
  requireString(image.alt, `${path}.alt`);
  const src = image.src.replaceAll("\\", "/");
  if (!src.startsWith("assets/") || src.split("/").includes("..") || /^[a-z]+:/i.test(src)) {
    throw new Error(`${path}.src muss ein relativer Pfad innerhalb von assets/ sein.`);
  }
}

function validateAudio(audio, path) {
  if (audio === undefined) return;
  if (!audio || typeof audio !== "object" || Array.isArray(audio)) throw new Error(`${path} muss ein Objekt sein.`);
  requireString(audio.src, `${path}.src`);
  requireString(audio.label, `${path}.label`);
  const src = audio.src.replaceAll("\\", "/");
  if (!src.startsWith("assets/") || src.split("/").includes("..") || /^[a-z]+:/i.test(src)) {
    throw new Error(`${path}.src muss ein relativer Pfad innerhalb von assets/ sein.`);
  }
}

function validateSide(item, textKey, imageKey, audioKey, path) {
  if (item[textKey] !== undefined && typeof item[textKey] !== "string") throw new Error(`${path}.${textKey} muss eine Zeichenfolge sein.`);
  validateImage(item[imageKey], `${path}.${imageKey}`);
  validateAudio(item[audioKey], `${path}.${audioKey}`);
  if (!(typeof item[textKey] === "string" && item[textKey].trim())
      && item[imageKey] === undefined && item[audioKey] === undefined) {
    throw new Error(`${path} benötigt ${textKey}, ${imageKey}, ${audioKey} oder eine Kombination daraus.`);
  }
}

export function validateConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("questions.json muss ein Objekt enthalten.");
  requireString(config.title, "title");
  if (!Array.isArray(config.teams) || !config.teams.length) throw new Error("teams muss mindestens ein Team enthalten.");
  config.teams.forEach((team, index) => {
    requireString(team?.name, `teams[${index}].name`);
    if (!Number.isInteger(team.startingScore)) throw new Error(`teams[${index}].startingScore muss eine Ganzzahl sein.`);
  });
  if (!Array.isArray(config.values) || !config.values.length) throw new Error("values muss mindestens einen Punktewert enthalten.");
  config.values.forEach((value, index) => {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`values[${index}] muss eine positive Ganzzahl sein.`);
  });
  if (!Array.isArray(config.categories) || !config.categories.length) throw new Error("categories muss mindestens eine Kategorie enthalten.");
  config.categories.forEach((category, categoryIndex) => {
    const path = `categories[${categoryIndex}]`;
    requireString(category?.name, `${path}.name`);
    if (category.reviewQuestionAfterAnswer !== undefined && typeof category.reviewQuestionAfterAnswer !== "boolean") {
      throw new Error(`${path}.reviewQuestionAfterAnswer muss ein Wahrheitswert sein.`);
    }
    if (!Array.isArray(category.questions) || category.questions.length !== config.values.length) {
      throw new Error(`${path}.questions muss genau ${config.values.length} Einträge enthalten.`);
    }
    category.questions.forEach((item, rowIndex) => {
      const itemPath = `${path}.questions[${rowIndex}]`;
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${itemPath} muss ein Objekt sein.`);
      validateSide(item, "question", "questionImage", "questionAudio", itemPath);
      validateSide(item, "answer", "answerImage", "answerAudio", itemPath);
    });
  });
  if (!config.ordering || typeof config.ordering !== "object" || Array.isArray(config.ordering)) {
    throw new Error("ordering muss ein Objekt sein.");
  }
  if (!Number.isInteger(config.ordering.pointsPerCorrect) || config.ordering.pointsPerCorrect <= 0) {
    throw new Error("ordering.pointsPerCorrect muss eine positive Ganzzahl sein.");
  }
  if (!Array.isArray(config.ordering.questions) || !config.ordering.questions.length) {
    throw new Error("ordering.questions muss mindestens eine Frage enthalten.");
  }
  const orderingIds = new Set();
  config.ordering.questions.forEach((question, index) => {
    const path = `ordering.questions[${index}]`;
    requireString(question?.id, `${path}.id`);
    requireString(question?.title, `${path}.title`);
    requireString(question?.prompt, `${path}.prompt`);
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(question.id) || orderingIds.has(question.id)) {
      throw new Error(`${path}.id muss eindeutig sein und darf nur Buchstaben, Zahlen und Bindestriche enthalten.`);
    }
    orderingIds.add(question.id);
    if (!Number.isInteger(question.timeLimitSeconds) || question.timeLimitSeconds < 5 || question.timeLimitSeconds > 600) {
      throw new Error(`${path}.timeLimitSeconds muss eine Ganzzahl von 5 bis 600 sein.`);
    }
    if (!Array.isArray(question.items) || question.items.length < 3 || question.items.length > 7) {
      throw new Error(`${path}.items muss 3 bis 7 Einträge in der richtigen Reihenfolge enthalten.`);
    }
    const unique = new Set();
    question.items.forEach((item, itemIndex) => {
      requireString(item, `${path}.items[${itemIndex}]`);
      const key = item.trim().toLocaleLowerCase();
      if (unique.has(key)) throw new Error(`${path}.items muss eindeutige Einträge enthalten.`);
      unique.add(key);
    });
    if (question.itemMaps !== undefined) {
      if (!question.itemMaps || typeof question.itemMaps !== "object" || Array.isArray(question.itemMaps)) {
        throw new Error(`${path}.itemMaps muss ein Objekt sein.`);
      }
      Object.entries(question.itemMaps).forEach(([item, image]) => {
        if (!question.items.includes(item)) throw new Error(`${path}.itemMaps enthält ein unbekanntes Element: ${item}.`);
        validateImage(image, `${path}.itemMaps[${JSON.stringify(item)}]`);
      });
    }
  });
  if (!config.listing || typeof config.listing !== "object" || Array.isArray(config.listing)) {
    throw new Error("listing muss ein Objekt sein.");
  }
  if (!Array.isArray(config.listing.questions) || !config.listing.questions.length) {
    throw new Error("listing.questions muss mindestens eine Frage enthalten.");
  }
  const listingIds = new Set();
  config.listing.questions.forEach((question, index) => {
    const path = `listing.questions[${index}]`;
    requireString(question?.id, `${path}.id`);
    requireString(question?.title, `${path}.title`);
    requireString(question?.prompt, `${path}.prompt`);
    requireString(question?.validationRule, `${path}.validationRule`);
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(question.id) || listingIds.has(question.id)) {
      throw new Error(`${path}.id muss eindeutig sein und darf nur Buchstaben, Zahlen und Bindestriche enthalten.`);
    }
    listingIds.add(question.id);
    if (!Number.isInteger(question.timeLimitSeconds) || question.timeLimitSeconds < 5 || question.timeLimitSeconds > 600) {
      throw new Error(`${path}.timeLimitSeconds muss eine Ganzzahl von 5 bis 600 sein.`);
    }
    if (!Number.isInteger(question.maxItems) || question.maxItems < 1 || question.maxItems > 50) {
      throw new Error(`${path}.maxItems muss eine Ganzzahl von 1 bis 50 sein.`);
    }
    if (!Array.isArray(question.placementPoints) || !question.placementPoints.length
        || question.placementPoints.some((points) => !Number.isInteger(points) || points < 0)) {
      throw new Error(`${path}.placementPoints muss nicht-negative Ganzzahlen enthalten.`);
    }
  });
  if (!config.syncUp || typeof config.syncUp !== "object" || Array.isArray(config.syncUp)) {
    throw new Error("syncUp muss ein Objekt sein.");
  }
  if (!Number.isInteger(config.syncUp.timeLimitSeconds)
      || config.syncUp.timeLimitSeconds < 1 || config.syncUp.timeLimitSeconds > 60) {
    throw new Error("syncUp.timeLimitSeconds muss eine Ganzzahl von 1 bis 60 sein.");
  }
  if (!Number.isInteger(config.syncUp.pointsPerSync) || config.syncUp.pointsPerSync <= 0) {
    throw new Error("syncUp.pointsPerSync muss eine positive Ganzzahl sein.");
  }
  if (!Array.isArray(config.syncUp.questions) || !config.syncUp.questions.length) {
    throw new Error("syncUp.questions muss mindestens einen Prompt enthalten.");
  }
  const syncIds = new Set();
  config.syncUp.questions.forEach((question, index) => {
    const path = `syncUp.questions[${index}]`;
    requireString(question?.id, `${path}.id`);
    requireString(question?.prompt, `${path}.prompt`);
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(question.id) || syncIds.has(question.id)) {
      throw new Error(`${path}.id muss eindeutig sein und darf nur Buchstaben, Zahlen und Bindestriche enthalten.`);
    }
    syncIds.add(question.id);
  });
  return config;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function fingerprint(config) {
  const bytes = new TextEncoder().encode(canonicalJson(config));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validateSavedState(saved) {
  if (!saved || typeof saved !== "object" || ![1, 2, 3].includes(saved.version)) throw new Error("Das gespeicherte Spiel hat ein nicht unterstütztes Format.");
  if (typeof saved.configFingerprint !== "string" || typeof saved.gameStarted !== "boolean") throw new Error("Im gespeicherten Spiel fehlen erforderliche Felder.");
  if (!Number.isInteger(saved.revision) || saved.revision < 1) throw new Error("Das gespeicherte Spiel hat eine ungültige Revision.");
  if (!Array.isArray(saved.teams) || !saved.teams.length) throw new Error("Das gespeicherte Spiel muss mindestens ein Team enthalten.");
  saved.teams.forEach((team) => {
    if (!team || typeof team.name !== "string" || !Number.isInteger(team.score)) throw new Error("Das gespeicherte Spiel enthält ein ungültiges Team.");
  });
  if (!Array.isArray(saved.usedTiles)) throw new Error("Das gespeicherte Spiel enthält ungültige verwendete Fragen.");
  saved.usedTiles.forEach((tileId) => {
    if (typeof tileId !== "string" || !/^\d+:\d+$/.test(tileId)) throw new Error("Das gespeicherte Spiel enthält eine ungültige Frage-ID.");
    const [categoryIndex, rowIndex] = tileId.split(":").map(Number);
    if (categoryIndex >= state.config.categories.length || rowIndex >= state.config.values.length) {
      throw new Error("Das gespeicherte Spiel verweist auf eine Frage, die nicht mehr existiert.");
    }
  });
  if (saved.activeQuestion !== null) {
    const active = saved.activeQuestion;
    if (!active || !Number.isInteger(active.categoryIndex) || !Number.isInteger(active.rowIndex)
        || typeof active.answerRevealed !== "boolean"
        || active.categoryIndex < 0 || active.categoryIndex >= state.config.categories.length
        || active.rowIndex < 0 || active.rowIndex >= state.config.values.length) {
      throw new Error("Das gespeicherte Spiel enthält eine ungültige aktive Frage.");
    }
  }
  if (saved.version === 1) saved = { ...saved, version: 2, appliedAwards: [] };
  if (!Array.isArray(saved.appliedAwards) || saved.appliedAwards.some((id) => typeof id !== "string" || !id)) {
    throw new Error("Das gespeicherte Spiel enthält ungültige Punktevergaben.");
  }
  if (saved.version === 2) saved = {
    ...saved, version: 3, scoreHistory: [{ scores: saved.teams.map(({ score }) => score) }]
  };
  if (!Array.isArray(saved.scoreHistory) || !saved.scoreHistory.length
      || saved.scoreHistory.some((entry) => !entry || !Array.isArray(entry.scores)
        || entry.scores.length !== saved.teams.length
        || entry.scores.some((score) => !Number.isInteger(score)))) {
    throw new Error("Das gespeicherte Spiel enthält einen ungültigen Punkteverlauf.");
  }
  if (!saved.scoreHistory.at(-1).scores.every((score, index) => score === saved.teams[index].score)) {
    throw new Error("Der letzte Punkteverlauf stimmt nicht mit dem aktuellen Punktestand überein.");
  }
  return saved;
}

async function loadSavedState() {
  const response = await fetch("/api/state", { cache: "no-store" });
  if (response.status === 404) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) return { invalid: true, configFingerprint: "", error: payload.error || `HTTP ${response.status}` };
  try { return validateSavedState(payload); }
  catch (error) { return { invalid: true, configFingerprint: "", error: error.message }; }
}

export async function loadApplicationData() {
  const response = await fetch("questions.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`questions.json konnte nicht geladen werden (HTTP ${response.status}).`);
  state.config = validateConfig(await response.json());
  state.configFingerprint = await fingerprint(state.config);
  state.savedState = await loadSavedState();
  document.title = state.config.title;
}

export function stateSnapshot() {
  return {
    version: 3,
    configFingerprint: state.configFingerprint,
    updatedAt: new Date().toISOString(),
    revision: ++state.revision,
    gameStarted: state.gameStarted,
    teams: state.teams.map(({ name, score }) => ({ name, score })),
    usedTiles: Array.from(state.usedTiles).sort(),
    activeQuestion: state.activeQuestion ? { ...state.activeQuestion } : null,
    appliedAwards: Array.from(state.appliedAwards).sort(),
    scoreHistory: state.scoreHistory.map(({ scores }) => ({ scores: [...scores] }))
  };
}

export function saveState() {
  if (!state.gameStarted) return state.saveChain;
  const snapshot = stateSnapshot();
  state.saveChain = state.saveChain.catch(() => undefined).then(async () => {
    const response = await fetch("/api/state", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(snapshot)
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.error || `HTTP ${response.status}`);
    }
    state.savedState = snapshot;
  }).catch((error) => { console.error("Could not save quiz state:", error); throw error; });
  return state.saveChain;
}

export async function deleteSavedState() {
  const response = await fetch("/api/state", { method: "DELETE" });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.error || `HTTP ${response.status}`);
  }
  state.savedState = null;
}

export function startRuntime(teams) {
  state.teams = teams.map((team) => ({ ...team }));
  state.usedTiles = new Set();
  state.activeValue = 0;
  state.activeQuestion = null;
  state.gameStarted = true;
  state.revision = 0;
  state.appliedAwards = new Set();
  state.scoreHistory = [{ scores: state.teams.map(({ score }) => score) }];
}

export function resumeRuntime(teams) {
  const saved = state.savedState;
  state.teams = teams.map((team) => ({ ...team }));
  state.usedTiles = new Set(saved.usedTiles);
  state.activeQuestion = saved.activeQuestion ? { ...saved.activeQuestion } : null;
  state.activeValue = 0;
  state.gameStarted = saved.gameStarted;
  state.revision = saved.revision;
  state.appliedAwards = new Set(saved.appliedAwards || []);
  state.scoreHistory = saved.scoreHistory.map(({ scores }) => ({ scores: [...scores] }));
}

export function recordScoreHistory() {
  const scores = state.teams.map(({ score }) => score);
  const previous = state.scoreHistory.at(-1)?.scores;
  if (previous?.length === scores.length && previous.every((score, index) => score === scores[index])) return false;
  state.scoreHistory.push({ scores });
  return true;
}

export function applyAward(awardId, awards) {
  if (state.appliedAwards.has(awardId)) return false;
  if (typeof awardId !== "string" || !awardId || !Array.isArray(awards)) throw new Error("Die Punktevergabe ist ungültig.");
  awards.forEach(({ teamIndex, points }) => {
    if (!Number.isInteger(teamIndex) || !state.teams[teamIndex] || !Number.isInteger(points) || points < 0) {
      throw new Error("Die Punktevergabe enthält ungültige Teampunkte.");
    }
  });
  awards.forEach(({ teamIndex, points }) => { state.teams[teamIndex].score += points; });
  recordScoreHistory();
  state.appliedAwards.add(awardId);
  return true;
}
