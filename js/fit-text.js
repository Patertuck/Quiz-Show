const pendingFits = new WeakMap();

function visibleTextElements(container, selector) {
  return [...container.querySelectorAll(selector)].filter((element) => element.getClientRects().length);
}

function overflows(container) {
  return container.scrollHeight > container.clientHeight + 1
    || container.scrollWidth > container.clientWidth + 1;
}

export function fitTextToContainer(container, selector = ".auto-fit-text") {
  if (!container?.isConnected || !container.clientWidth || !container.clientHeight) return;
  const textElements = visibleTextElements(container, selector);
  if (!textElements.length) return;

  textElements.forEach((element) => { element.style.fontSize = ""; });
  const naturalSizes = textElements.map((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  if (!overflows(container)) return;

  const applyScale = (scale) => textElements.forEach((element, index) => {
    element.style.fontSize = `${Math.max(1, naturalSizes[index] * scale).toFixed(3)}px`;
  });

  let lower = 0;
  let upper = 1;
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const scale = (lower + upper) / 2;
    applyScale(scale);
    if (overflows(container)) upper = scale;
    else lower = scale;
  }
  applyScale(lower);
}

export function scheduleTextFit(container, selector = ".auto-fit-text") {
  if (!container) return;
  const pending = pendingFits.get(container);
  if (pending) cancelAnimationFrame(pending);
  pendingFits.set(container, requestAnimationFrame(() => {
    pendingFits.delete(container);
    fitTextToContainer(container, selector);
  }));
}
