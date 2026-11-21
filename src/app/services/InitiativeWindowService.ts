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
  private chromeStyle: HTMLStyleElement | null = null;

  setup(view: ItemView): void {
    const targetWindow = view.contentEl.win;

    // If the view has returned to the main window, remove any previous popout styling.
    // Never apply initiative-window chrome rules to the main Obsidian window.
    if (targetWindow === window) {
      this.cleanup();
      return;
    }

    const targetDocument = view.contentEl.doc;
    if (targetWindow.closed || !targetDocument.body || !targetDocument.head) return;

    // If setup is called again, clean up the previous document before switching targets.
    if (this.targetWindow && this.targetWindow !== targetWindow) this.cleanup();

    this.targetWindow = targetWindow;
    this.copyMainWindowStyles(window.document, targetDocument);
    targetDocument.body.classList.add(INITIATIVE_WINDOW_BODY_CLASS);

    // Apply the chrome rules directly in this popout document. This avoids relying on
    // stylesheet-copy timing and cannot affect the main Obsidian window.
    this.chromeStyle?.remove();
    this.chromeStyle = targetDocument.createElement('style');
    this.chromeStyle.dataset.atlasInitiativeWindow = 'true';
    this.chromeStyle.textContent = `
      body.${INITIATIVE_WINDOW_BODY_CLASS} {
        width: 100vw;
        height: 100vh;
        margin: 0;
        padding: 0;
        overflow: hidden;
      }

      /* The native titlebar is hidden in this popout, so make the display itself
         a drag region, matching the Player Window's frameless-window behaviour. */
      body.${INITIATIVE_WINDOW_BODY_CLASS} .atlas-initiative-display-content,
      body.${INITIATIVE_WINDOW_BODY_CLASS} .atlas-initiative-display-content * {
        -webkit-app-region: drag;
      }

      body.${INITIATIVE_WINDOW_BODY_CLASS} .workspace-ribbon,
      body.${INITIATIVE_WINDOW_BODY_CLASS} .workspace-tab-header-container,
      body.${INITIATIVE_WINDOW_BODY_CLASS} .view-header,
      body.${INITIATIVE_WINDOW_BODY_CLASS} .status-bar,
      body.${INITIATIVE_WINDOW_BODY_CLASS} .titlebar {
        display: none !important;
      }
    `;
    targetDocument.head.appendChild(this.chromeStyle);
  }

  cleanup(): void {
    this.chromeStyle?.remove();
    this.chromeStyle = null;
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
