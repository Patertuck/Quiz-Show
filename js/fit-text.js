const pendingFits = new WeakMap();

function visibleTextElements(container, selector) {
  return [...container.querySelectorAll(selector)].filter((element) => element.getClientRects().length);
}

function overflows(container, textElements = []) {
  if (container.scrollHeight > container.clientHeight + 1
      || container.scrollWidth > container.clientWidth + 1) return true;
  const bounds = container.getBoundingClientRect();
  return textElements.some((element) => {
    const textBounds = element.getBoundingClientRect();
    return element.scrollHeight > element.clientHeight + 1
      || element.scrollWidth > element.clientWidth + 1
      || textBounds.top < bounds.top - 1 || textBounds.bottom > bounds.bottom + 1
      || textBounds.left < bounds.left - 1 || textBounds.right > bounds.right + 1;
  });
}

export function fitTextToContainer(container, selector = ".auto-fit-text", options = {}) {
  if (!container?.isConnected || !container.clientWidth || !container.clientHeight) return;
  const textElements = visibleTextElements(container, selector);
  if (!textElements.length) return;

  textElements.forEach((element) => { element.style.fontSize = ""; });
  const heightBasedMaximum = options.maxHeightRatio
    ? Math.max(1, container.clientHeight * options.maxHeightRatio)
    : Number.POSITIVE_INFINITY;
  const naturalSizes = textElements.map((element) => Math.min(
    Number.parseFloat(getComputedStyle(element).fontSize), heightBasedMaximum
  ));
  textElements.forEach((element, index) => {
    element.style.fontSize = `${naturalSizes[index].toFixed(3)}px`;
  });
  if (!overflows(container, textElements)) return;

  const applyScale = (scale) => textElements.forEach((element, index) => {
    element.style.fontSize = `${Math.max(1, naturalSizes[index] * scale).toFixed(3)}px`;
  });

  let lower = 0;
  let upper = 1;
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const scale = (lower + upper) / 2;
    applyScale(scale);
    if (overflows(container, textElements)) upper = scale;
    else lower = scale;
  }
  applyScale(lower);
}

export function scheduleTextFit(container, selector = ".auto-fit-text", options = {}) {
  if (!container) return;
  const pending = pendingFits.get(container);
  if (pending) cancelAnimationFrame(pending);
  pendingFits.set(container, requestAnimationFrame(() => {
    pendingFits.delete(container);
    fitTextToContainer(container, selector, options);
  }));
}
