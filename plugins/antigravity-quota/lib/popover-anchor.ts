export interface WindowAnchor {
  key: string;
  group: string;
  window: "5h" | "weekly";
  node: HTMLElement;
}

export interface PopoverAnchors {
  headerNode: HTMLElement;
  windows: WindowAnchor[];
}

export interface TooltipAnchor {
  group: string;
  window: "5h" | "weekly";
  node: HTMLElement;
}

export interface OverlayAnchors {
  popover: PopoverAnchors | null;
  tooltip: TooltipAnchor | null;
}

let currentAnchors: OverlayAnchors = { popover: null, tooltip: null };
const listeners = new Set<() => void>();

export const getPopoverAnchors = () => currentAnchors;

export function subscribePopoverAnchors(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function publish(next: OverlayAnchors) {
  currentAnchors = next;
  for (const listener of listeners) listener();
}

export function detectWindowKind(label: string): "5h" | "weekly" | null {
  const normalized = label.trim();
  if (/^(5 часов|5 hours?|5h|five[- ]?hour.*)$/i.test(normalized)) return "5h";
  if (/^(неделя|weekly.*|7d)$/i.test(normalized)) return "weekly";
  return null;
}

export function parseTooltipSummary(summary: string): { group: string; window: "5h" | "weekly" } | null {
  const beforeDash = summary.split("—")[0]?.trim() ?? "";
  if (!beforeDash) return null;
  const parts = beforeDash.split("·").map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const kind = detectWindowKind(parts[parts.length - 1]!);
    if (!kind) return null;
    return { group: parts.slice(0, -1).join(" · "), window: kind };
  }
  const kind = detectWindowKind(beforeDash);
  if (!kind) return null;
  return { group: "Gemini Models", window: kind };
}

function createScopedElement<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  pluginId: string,
): HTMLElementTagNameMap[K] {
  const el = doc.createElement(tag);
  el.dataset.bbPluginRoot = "";
  el.dataset.bbPlugin = pluginId;
  el.dataset.antigravityQuotaOwned = "";
  return el;
}

export function mountPopoverAnchors(doc: Document, pluginId: string) {
  const win = doc.defaultView!;
  let activePopover: HTMLElement | null = null;
  let popoverNodes: HTMLElement[] = [];
  let restorePopoverStyles: (() => void) | null = null;

  let activeTooltip: HTMLElement | null = null;
  let tooltipNode: HTMLElement | null = null;

  let frame: number | null = null;

  const detachPopover = () => {
    for (const node of popoverNodes) node.remove();
    popoverNodes = [];
    restorePopoverStyles?.();
    restorePopoverStyles = null;
    activePopover = null;
  };

  const detachTooltip = () => {
    tooltipNode?.remove();
    tooltipNode = null;
    activeTooltip = null;
  };

  const detachAll = () => {
    detachPopover();
    detachTooltip();
    publish({ popover: null, tooltip: null });
  };

  const syncPopover = (): { changed: boolean; value: PopoverAnchors | null } => {
    const popover = doc.querySelector<HTMLElement>(
      '[data-bb-plugin="usage-rings"].usage-rings-popover[aria-label*="Antigravity" i]',
    );

    if (!popover) {
      if (!activePopover && popoverNodes.length === 0) return { changed: false, value: null };
      detachPopover();
      return { changed: true, value: null };
    }

    const expectedWindows = popover.querySelectorAll(".usage-rings-group .usage-rings-window").length;
    const prevPopover = currentAnchors.popover;
    const stillMounted =
      popover === activePopover &&
      prevPopover !== null &&
      prevPopover.headerNode.isConnected &&
      prevPopover.windows.length === expectedWindows &&
      prevPopover.windows.every((entry) => entry.node.isConnected);

    if (stillMounted) return { changed: false, value: prevPopover };

    detachPopover();
    activePopover = popover;

    const heading = popover.querySelector<HTMLElement>(".usage-rings-heading");
    if (!heading) return { changed: true, value: null };

    const titleEl = heading.querySelector<HTMLElement>("strong");
    const prevWidth = popover.style.width;
    const prevMaxHeight = popover.style.maxHeight;
    const prevTitleWhiteSpace = titleEl?.style.whiteSpace ?? "";
    popover.style.width = "min(324px, calc(100vw - 24px))";
    popover.style.maxHeight = "min(540px, var(--radix-popover-content-available-height))";
    if (titleEl) titleEl.style.whiteSpace = "nowrap";
    restorePopoverStyles = () => {
      popover.style.width = prevWidth;
      popover.style.maxHeight = prevMaxHeight;
      if (titleEl) titleEl.style.whiteSpace = prevTitleWhiteSpace;
    };

    const headerNode = createScopedElement(doc, "span", pluginId);
    headerNode.className = "inline-flex items-center";
    const spacer = heading.querySelector<HTMLElement>(".usage-rings-spacer");
    const firstAction = heading.querySelector<HTMLElement>(".usage-rings-action");
    if (firstAction) heading.insertBefore(headerNode, firstAction);
    else if (spacer && spacer.nextSibling) heading.insertBefore(headerNode, spacer.nextSibling);
    else heading.append(headerNode);
    popoverNodes.push(headerNode);

    const windows: WindowAnchor[] = [];
    popover.querySelectorAll<HTMLElement>(".usage-rings-group").forEach((groupEl, groupIndex) => {
      const groupTitle = groupEl.querySelector<HTMLElement>(".usage-rings-group-title")?.textContent?.trim();
      if (!groupTitle) return;
      groupEl.querySelectorAll<HTMLElement>(".usage-rings-window").forEach((winEl, winIndex) => {
        const label = winEl.querySelector<HTMLElement>("div > span")?.textContent?.trim() ?? "";
        const kind = detectWindowKind(label);
        if (!kind) return;
        const slotNode = createScopedElement(doc, "div", pluginId);
        winEl.append(slotNode);
        popoverNodes.push(slotNode);
        windows.push({
          key: `${groupIndex}-${winIndex}-${groupTitle}-${kind}`,
          group: groupTitle,
          window: kind,
          node: slotNode,
        });
      });
    });

    return { changed: true, value: { headerNode, windows } };
  };

  const syncTooltip = (): { changed: boolean; value: TooltipAnchor | null } => {
    const tooltip = doc.querySelector<HTMLElement>(
      '[data-bb-plugin="usage-rings"].usage-rings-tooltip',
    );
    const title = tooltip?.querySelector<HTMLElement>(".usage-rings-tooltip-title")?.textContent?.trim() ?? "";
    const isAntigravity = Boolean(tooltip && /Antigravity/i.test(title));
    if (!tooltip || !isAntigravity) {
      if (!activeTooltip && !tooltipNode) return { changed: false, value: null };
      detachTooltip();
      return { changed: true, value: null };
    }

    const summaryText = tooltip.querySelector<HTMLElement>(".usage-rings-tooltip-value")?.textContent?.trim() ?? "";
    const parsed = parseTooltipSummary(summaryText);
    if (!parsed) {
      if (!activeTooltip && !tooltipNode) return { changed: false, value: null };
      detachTooltip();
      return { changed: true, value: null };
    }

    const prevTooltip = currentAnchors.tooltip;
    if (
      tooltip === activeTooltip &&
      tooltipNode?.isConnected &&
      prevTooltip &&
      prevTooltip.group === parsed.group &&
      prevTooltip.window === parsed.window
    ) {
      return { changed: false, value: prevTooltip };
    }

    detachTooltip();
    activeTooltip = tooltip;
    tooltipNode = createScopedElement(doc, "div", pluginId);
    tooltip.append(tooltipNode);
    return {
      changed: true,
      value: { group: parsed.group, window: parsed.window, node: tooltipNode },
    };
  };

  const sync = () => {
    frame = null;
    const pop = syncPopover();
    const tip = syncTooltip();
    if (pop.changed || tip.changed) {
      publish({ popover: pop.value, tooltip: tip.value });
    }
  };

  const observer = new win.MutationObserver((records) => {
    if (
      records.every(
        (record) =>
          record.target instanceof win.Element &&
          record.target.closest("[data-antigravity-quota-owned]"),
      )
    ) {
      return;
    }
    if (frame === null) frame = win.requestAnimationFrame(sync);
  });

  observer.observe(doc.body, { childList: true, subtree: true });
  sync();

  return () => {
    observer.disconnect();
    if (frame !== null) win.cancelAnimationFrame(frame);
    detachAll();
  };
}
