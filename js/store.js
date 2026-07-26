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
  appliedAwards: new Set()
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

function validateSide(item, textKey, imageKey, path) {
  if (item[textKey] !== undefined && typeof item[textKey] !== "string") throw new Error(`${path}.${textKey} muss eine Zeichenfolge sein.`);
  validateImage(item[imageKey], `${path}.${imageKey}`);
  if (!(typeof item[textKey] === "string" && item[textKey].trim()) && item[imageKey] === undefined) {
    throw new Error(`${path} needs ${textKey} text, ${imageKey}, or both.`);
  }
}

export function validateConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("config.json muss ein Objekt enthalten.");
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
    if (!Array.isArray(category.questions) || category.questions.length !== config.values.length) {
      throw new Error(`${path}.questions muss genau ${config.values.length} Einträge enthalten.`);
    }
    category.questions.forEach((item, rowIndex) => {
      const itemPath = `${path}.questions[${rowIndex}]`;
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${itemPath} muss ein Objekt sein.`);
      validateSide(item, "question", "questionImage", itemPath);
      validateSide(item, "answer", "answerImage", itemPath);
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
  if (!saved || typeof saved !== "object" || ![1, 2].includes(saved.version)) throw new Error("Das gespeicherte Spiel hat ein nicht unterstütztes Format.");
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
  const response = await fetch("config.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`config.json konnte nicht geladen werden (HTTP ${response.status}).`);
  state.config = validateConfig(await response.json());
  state.configFingerprint = await fingerprint(state.config);
  state.savedState = await loadSavedState();
  document.title = state.config.title;
}

export function stateSnapshot() {
  return {
    version: 2,
    configFingerprint: state.configFingerprint,
    updatedAt: new Date().toISOString(),
    revision: ++state.revision,
    gameStarted: state.gameStarted,
    teams: state.teams.map(({ name, score }) => ({ name, score })),
    usedTiles: Array.from(state.usedTiles).sort(),
    activeQuestion: state.activeQuestion ? { ...state.activeQuestion } : null,
    appliedAwards: Array.from(state.appliedAwards).sort()
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
}

export function applyAward(awardId, awards) {
  if (state.appliedAwards.has(awardId)) return false;
  if (typeof awardId !== "string" || !awardId || !Array.isArray(awards)) throw new Error("Die Punktevergabe von Order Up ist ungültig.");
  awards.forEach(({ teamIndex, points }) => {
    if (!Number.isInteger(teamIndex) || !state.teams[teamIndex] || !Number.isInteger(points) || points < 0) {
      throw new Error("Die Punktevergabe von Order Up enthält ungültige Teampunkte.");
    }
  });
  awards.forEach(({ teamIndex, points }) => { state.teams[teamIndex].score += points; });
  state.appliedAwards.add(awardId);
  return true;
}
