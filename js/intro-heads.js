const HEAD_SOURCES = Array.from({ length: 6 }, (_, index) =>
  `assets/Logos/Partners/partner-head-${index + 1}.png`);

const SLOTS = [
  { edge: "left", position: 0.04 }, { edge: "left", position: 0.37 }, { edge: "left", position: 0.7 },
  { edge: "right", position: 0.04 }, { edge: "right", position: 0.37 }, { edge: "right", position: 0.7 },
  { edge: "top", position: 0.06 }, { edge: "top", position: 0.72 },
  { edge: "bottom", position: 0.06 }, { edge: "bottom", position: 0.72 }
];

const LOGO_FACE_TARGETS = [
  { x: 0.25, y: 0.25 },
  { x: 0.5, y: 0.24 },
  { x: 0.76, y: 0.25 },
  { x: 0.25, y: 0.75 },
  { x: 0.76, y: 0.75 }
];

function shuffledIndexes() {
  const values = HEAD_SOURCES.map((_, index) => index);
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [values[index], values[swap]] = [values[swap], values[index]];
  }
  return values;
}

function rotationForEdge(edge) {
  const wobble = -6 + Math.random() * 12;
  if (edge === "left") return 90 + wobble;
  if (edge === "right") return -90 + wobble;
  if (edge === "top") return 180 + wobble;
  return wobble;
}

export function createIntroHeads(container) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return () => undefined;

  const layer = document.createElement("div");
  layer.className = "intro-head-layer";
  layer.setAttribute("aria-hidden", "true");
  const kissLayer = document.createElement("div");
  kissLayer.className = "intro-kiss-layer";
  kissLayer.setAttribute("aria-hidden", "true");
  container.append(layer, kissLayer);

  let stopped = false;
  let timer = 0;
  let kissTimer = 0;
  let kissActive = false;
  let firstKissShown = false;
  let queue = shuffledIndexes();
  const active = new Map();
  const occupiedSlots = new Set();
  const effectTimers = new Set();

  const nextHead = () => {
    if (!queue.length) queue = shuffledIndexes();
    const availableIndex = queue.findIndex((index) => !active.has(index));
    if (availableIndex === -1) return null;
    return queue.splice(availableIndex, 1)[0];
  };

  const freeSlot = () => {
    const available = SLOTS.map((slot, index) => ({ slot, index }))
      .filter(({ index }) => !occupiedSlots.has(index));
    return available[Math.floor(Math.random() * available.length)];
  };

  const logoContentRect = () => {
    const logo = container.querySelector(".intro-logo, .display-intro-logo");
    if (!logo) return null;
    const containerRect = container.getBoundingClientRect();
    const elementRect = logo.getBoundingClientRect();
    let width = elementRect.width;
    let height = elementRect.height;
    let left = elementRect.left - containerRect.left;
    let top = elementRect.top - containerRect.top;
    const intrinsicWidth = logo.videoWidth || width;
    const intrinsicHeight = logo.videoHeight || height;
    if (width && height && intrinsicWidth && intrinsicHeight) {
      const contentRatio = intrinsicWidth / intrinsicHeight;
      const elementRatio = width / height;
      if (contentRatio > elementRatio) {
        const contentHeight = width / contentRatio;
        top += (height - contentHeight) / 2;
        height = contentHeight;
      } else {
        const contentWidth = height * contentRatio;
        left += (width - contentWidth) / 2;
        width = contentWidth;
      }
    }
    return { left, top, width, height };
  };

  const burstHearts = (x, y) => {
    for (let index = 0; index < 6; index += 1) {
      const heart = document.createElement("span");
      heart.className = "intro-kiss-heart";
      heart.textContent = "♥";
      heart.style.left = `${x}px`;
      heart.style.top = `${y}px`;
      const angle = (-150 + index * 24 + Math.random() * 12) * Math.PI / 180;
      const distance = 45 + Math.random() * 65;
      heart.style.setProperty("--heart-x", `${Math.cos(angle) * distance}px`);
      heart.style.setProperty("--heart-y", `${Math.sin(angle) * distance}px`);
      heart.style.setProperty("--heart-rotate", `${-35 + Math.random() * 70}deg`);
      heart.style.animationDelay = `${index * 35}ms`;
      kissLayer.append(heart);
      const cleanupTimer = window.setTimeout(() => {
        effectTimers.delete(cleanupTimer);
        heart.remove();
      }, 1500);
      effectTimers.add(cleanupTimer);
    }
  };

  const spawnKiss = () => {
    if (stopped || kissActive) return false;
    const bounds = container.getBoundingClientRect();
    const logoRect = logoContentRect();
    if (!bounds.width || !bounds.height || !logoRect?.width || !logoRect.height) return false;
    const headIndex = nextHead();
    if (headIndex === null) return false;

    kissActive = true;
    firstKissShown = true;
    const image = document.createElement("img");
    image.className = "intro-popup-head intro-kiss-head";
    image.src = HEAD_SOURCES[headIndex];
    image.alt = "";
    image.draggable = false;
    const size = Math.round(Math.max(110, Math.min(230, logoRect.width * (0.16 + Math.random() * 0.035))));
    image.style.width = `${size}px`;
    kissLayer.append(image);

    const target = LOGO_FACE_TARGETS[Math.floor(Math.random() * LOGO_FACE_TARGETS.length)];
    const contactX = logoRect.left + logoRect.width * target.x;
    const contactY = logoRect.top + logoRect.height * target.y;
    const fromLeft = Math.random() < 0.5;
    const outsideX = fromLeft ? -size * 1.1 : bounds.width + size * 0.1;
    const outsideY = Math.max(0, Math.min(bounds.height - size, contactY - size * (0.35 + Math.random() * 0.3)));
    const kissX = contactX - size * (fromLeft ? 0.76 : 0.24);
    const kissY = contactY - size * 0.5;
    const approachX = outsideX + (kissX - outsideX) * 0.68;
    const approachY = outsideY + (kissY - outsideY) * 0.68 - size * 0.12;
    const recoilX = kissX + (fromLeft ? -size * 0.14 : size * 0.14);
    const recoilY = kissY - size * 0.05;
    const startRotation = fromLeft ? 88 : -88;
    const kissRotation = fromLeft ? 12 : -12;
    const duration = 3400;
    const contactOffset = 0.46;
    const animation = image.animate([
      { transform: `translate(${outsideX}px, ${outsideY}px) rotate(${startRotation}deg) scale(.72)`, opacity: 0, offset: 0 },
      { transform: `translate(${approachX}px, ${approachY}px) rotate(${kissRotation * 2}deg) scale(.92)`, opacity: 1, offset: 0.3 },
      { transform: `translate(${kissX}px, ${kissY}px) rotate(${kissRotation}deg) scale(1)`, opacity: 1, offset: contactOffset },
      { transform: `translate(${kissX}px, ${kissY}px) rotate(${kissRotation}deg) scale(1.13)`, opacity: 1, offset: 0.53 },
      { transform: `translate(${recoilX}px, ${recoilY}px) rotate(${kissRotation * 1.5}deg) scale(.95)`, opacity: 1, offset: 0.64 },
      { transform: `translate(${kissX}px, ${kissY}px) rotate(${kissRotation}deg) scale(1)`, opacity: 1, offset: 0.72 },
      { transform: `translate(${outsideX}px, ${outsideY}px) rotate(${startRotation}deg) scale(.72)`, opacity: 0, offset: 1 }
    ], { duration, easing: "cubic-bezier(.2,.8,.2,1)", fill: "forwards" });

    const heartTimer = window.setTimeout(() => {
      effectTimers.delete(heartTimer);
      if (!stopped) burstHearts(contactX, contactY);
    }, duration * contactOffset);
    effectTimers.add(heartTimer);
    active.set(headIndex, animation);
    animation.finished.catch(() => undefined).finally(() => {
      active.delete(headIndex);
      kissActive = false;
      image.remove();
    });
    return true;
  };

  const spawn = () => {
    if (stopped || active.size >= 2) return;
    const bounds = container.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;

    const headIndex = nextHead();
    if (headIndex === null) return;
    const selection = freeSlot();
    if (!selection) return;
    occupiedSlots.add(selection.index);

    const image = document.createElement("img");
    image.className = "intro-popup-head";
    image.src = HEAD_SOURCES[headIndex];
    image.alt = "";
    image.draggable = false;
    const size = Math.round(Math.max(135, Math.min(330, Math.min(bounds.width, bounds.height) * (0.24 + Math.random() * 0.08))));
    image.style.width = `${size}px`;
    layer.append(image);

    const { edge, position } = selection.slot;
    let restX;
    let restY;
    let outsideX;
    let outsideY;
    const visibleFraction = 0.76 + Math.random() * 0.22;
    if (edge === "left" || edge === "right") {
      restX = edge === "left" ? -size * (1 - visibleFraction) : bounds.width - size * visibleFraction;
      restY = Math.min(bounds.height - size * 0.72, bounds.height * position);
      outsideX = edge === "left" ? -size * 1.15 : bounds.width + size * 0.15;
      outsideY = restY;
    } else {
      restX = Math.min(bounds.width - size * 0.72, bounds.width * position);
      restY = edge === "top" ? -size * (1 - visibleFraction) : bounds.height - size * visibleFraction;
      outsideX = restX;
      outsideY = edge === "top" ? -size * 1.15 : bounds.height + size * 0.15;
    }

    const rotation = rotationForEdge(edge);
    const shy = Math.random() < 0.58;
    const partialProgress = 0.34 + Math.random() * 0.2;
    const partialX = outsideX + (restX - outsideX) * partialProgress;
    const partialY = outsideY + (restY - outsideY) * partialProgress;
    const enter = 500 + Math.random() * 300;
    const hesitation = shy ? 500 + Math.random() * 900 : 0;
    const commit = shy ? 350 + Math.random() * 350 : 0;
    const hold = 2500 + Math.random() * 2000;
    const exit = 600 + Math.random() * 300;
    const total = enter + hesitation + commit + hold + exit;
    const outsideTransform = `translate(${outsideX}px, ${outsideY}px) rotate(${rotation + (edge === "left" || edge === "top" ? -7 : 7)}deg) scale(.78)`;
    const restTransform = `translate(${restX}px, ${restY}px) rotate(${rotation}deg) scale(1)`;
    const frames = [
      { transform: outsideTransform, opacity: 0, offset: 0 }
    ];
    if (shy) {
      const partialTransform = `translate(${partialX}px, ${partialY}px) rotate(${rotation + (Math.random() * 6 - 3)}deg) scale(.9)`;
      frames.push(
        { transform: partialTransform, opacity: 1, offset: enter / total },
        { transform: partialTransform, opacity: 1, offset: (enter + hesitation) / total },
        { transform: restTransform, opacity: 1, offset: (enter + hesitation + commit) / total }
      );
    } else {
      frames.push({ transform: restTransform, opacity: 1, offset: enter / total });
    }
    frames.push(
      { transform: restTransform, opacity: 1, offset: (total - exit) / total },
      { transform: outsideTransform, opacity: 0, offset: 1 }
    );
    const animation = image.animate(frames,
      { duration: total, easing: "cubic-bezier(.2,.8,.2,1)", fill: "forwards" });

    active.set(headIndex, animation);
    animation.finished.catch(() => undefined).finally(() => {
      active.delete(headIndex);
      occupiedSlots.delete(selection.index);
      image.remove();
    });
  };

  const schedule = () => {
    if (stopped) return;
    timer = window.setTimeout(() => {
      if (!firstKissShown || Math.random() >= 0.15 || !spawnKiss()) spawn();
      schedule();
    }, 1000 + Math.random() * 800);
  };

  const guaranteeFirstKiss = (delay = 6000 + Math.random() * 4000) => {
    kissTimer = window.setTimeout(() => {
      if (!spawnKiss() && !stopped) guaranteeFirstKiss(1000);
    }, delay);
  };

  HEAD_SOURCES.forEach((src) => { const preload = new Image(); preload.src = src; });
  spawn();
  schedule();
  guaranteeFirstKiss();

  return () => {
    stopped = true;
    clearTimeout(timer);
    clearTimeout(kissTimer);
    effectTimers.forEach((effectTimer) => clearTimeout(effectTimer));
    effectTimers.clear();
    active.forEach((animation) => animation.cancel());
    active.clear();
    layer.remove();
    kissLayer.remove();
  };
}
