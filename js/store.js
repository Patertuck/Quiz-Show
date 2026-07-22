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
  revision: 0
};

function requireString(value, path) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${path} must be a non-empty string.`);
}

function validateImage(image, path) {
  if (image === undefined) return;
  if (!image || typeof image !== "object" || Array.isArray(image)) throw new Error(`${path} must be an object.`);
  requireString(image.src, `${path}.src`);
  requireString(image.alt, `${path}.alt`);
  const src = image.src.replaceAll("\\", "/");
  if (!src.startsWith("assets/") || src.split("/").includes("..") || /^[a-z]+:/i.test(src)) {
    throw new Error(`${path}.src must be a relative path beneath assets/.`);
  }
}

function validateSide(item, textKey, imageKey, path) {
  if (item[textKey] !== undefined && typeof item[textKey] !== "string") throw new Error(`${path}.${textKey} must be a string.`);
  validateImage(item[imageKey], `${path}.${imageKey}`);
  if (!(typeof item[textKey] === "string" && item[textKey].trim()) && item[imageKey] === undefined) {
    throw new Error(`${path} needs ${textKey} text, ${imageKey}, or both.`);
  }
}

export function validateConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("config.json must contain an object.");
  requireString(config.title, "title");
  if (!Array.isArray(config.teams) || !config.teams.length) throw new Error("teams must contain at least one team.");
  config.teams.forEach((team, index) => {
    requireString(team?.name, `teams[${index}].name`);
    if (!Number.isInteger(team.startingScore)) throw new Error(`teams[${index}].startingScore must be an integer.`);
  });
  if (!Array.isArray(config.values) || !config.values.length) throw new Error("values must contain at least one point value.");
  config.values.forEach((value, index) => {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`values[${index}] must be a positive integer.`);
  });
  if (!Array.isArray(config.categories) || !config.categories.length) throw new Error("categories must contain at least one category.");
  config.categories.forEach((category, categoryIndex) => {
    const path = `categories[${categoryIndex}]`;
    requireString(category?.name, `${path}.name`);
    if (!Array.isArray(category.questions) || category.questions.length !== config.values.length) {
      throw new Error(`${path}.questions must contain exactly ${config.values.length} entries.`);
    }
    category.questions.forEach((item, rowIndex) => {
      const itemPath = `${path}.questions[${rowIndex}]`;
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${itemPath} must be an object.`);
      validateSide(item, "question", "questionImage", itemPath);
      validateSide(item, "answer", "answerImage", itemPath);
    });
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
  if (!saved || typeof saved !== "object" || saved.version !== 1) throw new Error("The saved game has an unsupported format.");
  if (typeof saved.configFingerprint !== "string" || typeof saved.gameStarted !== "boolean") throw new Error("The saved game is missing required fields.");
  if (!Number.isInteger(saved.revision) || saved.revision < 1) throw new Error("The saved game has an invalid revision.");
  if (!Array.isArray(saved.teams) || !saved.teams.length) throw new Error("The saved game must contain at least one team.");
  saved.teams.forEach((team) => {
    if (!team || typeof team.name !== "string" || !Number.isInteger(team.score)) throw new Error("The saved game contains an invalid team.");
  });
  if (!Array.isArray(saved.usedTiles)) throw new Error("The saved game has invalid used questions.");
  saved.usedTiles.forEach((tileId) => {
    if (typeof tileId !== "string" || !/^\d+:\d+$/.test(tileId)) throw new Error("The saved game contains an invalid question identifier.");
    const [categoryIndex, rowIndex] = tileId.split(":").map(Number);
    if (categoryIndex >= state.config.categories.length || rowIndex >= state.config.values.length) {
      throw new Error("The saved game refers to a question that no longer exists.");
    }
  });
  if (saved.activeQuestion !== null) {
    const active = saved.activeQuestion;
    if (!active || !Number.isInteger(active.categoryIndex) || !Number.isInteger(active.rowIndex)
        || typeof active.answerRevealed !== "boolean"
        || active.categoryIndex < 0 || active.categoryIndex >= state.config.categories.length
        || active.rowIndex < 0 || active.rowIndex >= state.config.values.length) {
      throw new Error("The saved game contains an invalid active question.");
    }
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
  if (!response.ok) throw new Error(`Could not load config.json (HTTP ${response.status}).`);
  state.config = validateConfig(await response.json());
  state.configFingerprint = await fingerprint(state.config);
  state.savedState = await loadSavedState();
  document.title = state.config.title;
}

export function stateSnapshot() {
  return {
    version: 1,
    configFingerprint: state.configFingerprint,
    updatedAt: new Date().toISOString(),
    revision: ++state.revision,
    gameStarted: state.gameStarted,
    teams: state.teams.map(({ name, score }) => ({ name, score })),
    usedTiles: Array.from(state.usedTiles).sort(),
    activeQuestion: state.activeQuestion ? { ...state.activeQuestion } : null
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
}

export function resumeRuntime(teams) {
  const saved = state.savedState;
  state.teams = teams.map((team) => ({ ...team }));
  state.usedTiles = new Set(saved.usedTiles);
  state.activeQuestion = saved.activeQuestion ? { ...saved.activeQuestion } : null;
  state.activeValue = 0;
  state.gameStarted = saved.gameStarted;
  state.revision = saved.revision;
}
