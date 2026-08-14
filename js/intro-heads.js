const HEAD_SOURCES = Array.from({ length: 6 }, (_, index) =>
  `assets/Logos/Partners/partner-head-${index + 1}.png`);

const SLOTS = [
  { edge: "left", position: 0.04 }, { edge: "left", position: 0.37 }, { edge: "left", position: 0.7 },
  { edge: "right", position: 0.04 }, { edge: "right", position: 0.37 }, { edge: "right", position: 0.7 },
  { edge: "top", position: 0.06 }, { edge: "top", position: 0.72 },
  { edge: "bottom", position: 0.06 }, { edge: "bottom", position: 0.72 }
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
  container.append(layer);

  let stopped = false;
  let timer = 0;
  let queue = shuffledIndexes();
  const active = new Map();
  const occupiedSlots = new Set();

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
      spawn();
      schedule();
    }, 1000 + Math.random() * 800);
  };

  HEAD_SOURCES.forEach((src) => { const preload = new Image(); preload.src = src; });
  spawn();
  schedule();

  return () => {
    stopped = true;
    clearTimeout(timer);
    active.forEach((animation) => animation.cancel());
    active.clear();
    layer.remove();
  };
}
