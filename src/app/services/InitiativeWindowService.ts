import type { ItemView } from 'obsidian';

/** The body class is deliberately scoped to the Initiative Display's own popout document. */
export const INITIATIVE_WINDOW_BODY_CLASS = 'atlas-initiative-window';

/**
 * Owns the small amount of Obsidian-window setup needed by the Initiative Display.
 * This follows LocalPlayerView/PlayerWindowService: identify the popout through contentEl.win,
 * mirror the main window's stylesheets, then mark only the popout body.
 */
export class InitiativeWindowService {
  private targetWindow: Window | null = null;

  setup(view: ItemView): void {
    const targetWindow = view.contentEl.win;

    // This is the same reliable check used by LocalPlayerView. Never touch the main window.
    if (targetWindow === window) return;

    const targetDocument = view.contentEl.doc;
    if (targetWindow.closed || !targetDocument.body || !targetDocument.head) return;

    // If setup is called again, clean up the previous document before switching targets.
    if (this.targetWindow && this.targetWindow !== targetWindow) this.cleanup();

    this.targetWindow = targetWindow;
    this.copyMainWindowStyles(window.document, targetDocument);
    targetDocument.body.classList.add(INITIATIVE_WINDOW_BODY_CLASS);
  }

  cleanup(): void {
    if (this.targetWindow && !this.targetWindow.closed) {
      this.targetWindow.document.body.classList.remove(INITIATIVE_WINDOW_BODY_CLASS);
    }
    this.targetWindow = null;
  }

  /** Mirrors the PlayerWindowService stylesheet-copying approach for Obsidian popouts. */
  private copyMainWindowStyles(sourceDocument: Document, targetDocument: Document): void {
    const styleKey = (node: Element): string => node.tagName === 'LINK'
      ? `link:${(node as HTMLLinkElement).href}`
      : `style:${node.textContent ?? ''}`;
    const existing = new Set(
      Array.from(targetDocument.head.querySelectorAll('link[rel="stylesheet"], style')).map(styleKey),
    );

    sourceDocument.head.querySelectorAll('link[rel="stylesheet"], style').forEach((node) => {
      const key = styleKey(node);
      if (existing.has(key)) return;
      targetDocument.head.appendChild(targetDocument.importNode(node, true));
      existing.add(key);
    });
  }
}
