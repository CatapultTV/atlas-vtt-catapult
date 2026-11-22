import { ItemView, type WorkspaceLeaf, type ViewStateResult } from 'obsidian';
import { AtlasView } from './atlas-view';
import { ATLAS_VIEW_TYPE } from './atlasViewType';
import { mapConditions } from './gameSystems/mapRules';
import { currentTurn, turnEntries } from './initiative/turnHolders';
import { mapResources } from './resources/collectionResources';
import { visibleResources } from './resources/visibleResources';
import { defeatedCombatants } from './initiative/defeated';
import { mapInitiativeRules } from './services/mapInitiativeRules';
import { rulesLookup } from './services/mapRules';
import { playersEntryToken, sideIdsOf, type EntryToken } from './services/playerInitiativeList';
import { nameShownToPlayers } from './pixi/token-renderer/nameplateVisibility';
import { WIDGET_ICON_PATHS } from './types/widgetIcons';
import { conditionGlyph, isLightBadgeColor } from './utils/conditionGlyph';
import { portraitSrc } from './utils/portraitSrc';
import type { TokenEntity } from './types';
import type { InitiativeEntry } from './types/initiativeTypes';
import type { ViewAtlasState } from './storeFactory';
import { t } from './i18n';
import './initiative-display.scss';
import { InitiativeWindowService } from './services/InitiativeWindowService';

export const INITIATIVE_DISPLAY_VIEW_TYPE = 'atlas-vtt-initiative-display';

interface InitiativeDisplaySession {
  sourceViewId: string;
  sourceFilePath?: string;
}

/** A combatant after applying the same visibility rules as Atlas' player-facing initiative list. */
interface VisibleCombatant {
  entry: InitiativeEntry;
  token: TokenEntity | undefined;
  playerToken: EntryToken;
}

interface InitiativeDisplayAnimationSnapshot {
  badgeRects: Map<string, { left: number; top: number; width: number; height: number }>;
  portraitRects: Map<string, { left: number; top: number; width: number; height: number }>;
  conditionKeyIds: Set<string>;
}

/**
 * A read-only, standalone initiative screen. It subscribes directly to the selected Atlas view's
 * store, rather than to the DM tracker panel, so hiding that panel never stops this display.
 */
export class InitiativeDisplayView extends ItemView {
  private session: InitiativeDisplaySession = { sourceViewId: '' };
  private sourceView: AtlasView | null = null;
  private stopStore: (() => void) | null = null;
  private stopSettings: (() => void) | null = null;
  private reconnectQueued = false;
  private keyResizeObserver: ResizeObserver | null = null;
  private startupPending = true;
  private combatWasActive = false;
  private readonly initiativeWindowService = new InitiativeWindowService();

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string { return INITIATIVE_DISPLAY_VIEW_TYPE; }
  getDisplayText(): string { return 'Initiative Display'; }
  getIcon(): string { return 'swords'; }
  getState(): InitiativeDisplaySession { return { ...this.session }; }

  async setState(state: unknown, _result: ViewStateResult): Promise<void> {
    if (typeof state !== 'object' || state === null || !('sourceViewId' in state) || typeof state.sourceViewId !== 'string') return;
    this.session = {
      sourceViewId: state.sourceViewId,
      ...('sourceFilePath' in state && typeof state.sourceFilePath === 'string' ? { sourceFilePath: state.sourceFilePath } : {}),
    };
    this.queueReconnect();
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass('atlas-initiative-display-content');

    this.initiativeWindowService.setup(this);
    this.contentEl.setText('Connecting to the Atlas map…');
    this.registerEvent(this.app.workspace.on('layout-change', () => {
      // Obsidian can move this leaf into a popout after onOpen has already run.
      // Re-evaluate its owning window each time the workspace layout changes.
      this.initiativeWindowService.setup(this);
      this.queueReconnect();
    }));
    this.app.workspace.onLayoutReady(() => {
      this.initiativeWindowService.setup(this);
      this.queueReconnect();
    });
  }

  async onClose(): Promise<void> {
    this.disconnect();
    this.startupPending = true;
    this.combatWasActive = false;
    this.keyResizeObserver?.disconnect();
    this.keyResizeObserver = null;
    this.initiativeWindowService.cleanup();
    this.contentEl.empty();
  }

  private queueReconnect(): void {
    if (this.reconnectQueued) return;
    this.reconnectQueued = true;
    this.app.workspace.onLayoutReady(() => {
      this.reconnectQueued = false;
      if (this.contentEl.isConnected) this.connectToSource();
    });
  }

  private connectToSource(): void {
    const source = this.app.workspace.getLeavesOfType(ATLAS_VIEW_TYPE)
      .map((leaf) => leaf.view)
      .find((view): view is AtlasView => view instanceof AtlasView && (
        view.viewId === this.session.sourceViewId
        || (!!this.session.sourceFilePath && view.atlasStore.getState().mapPath === this.session.sourceFilePath)
      )) ?? null;

    if (source === this.sourceView && this.stopStore) return;
    this.disconnect();
    this.sourceView = source;
    if (!source) {
      this.contentEl.empty();
      this.contentEl.createDiv({ cls: 'atlas-initiative-display__empty', text: 'The Atlas map this display was connected to is no longer open.' });
      return;
    }

    this.stopStore = source.atlasStore.subscribe((state) => this.renderSafely(state));
    const settings = source.serviceManager.getSettingsService();
    this.stopSettings = settings.onChange(() => this.renderSafely(source.atlasStore.getState()));
    this.renderSafely(source.atlasStore.getState());
  }

  private disconnect(): void {
    this.stopStore?.();
    this.stopStore = null;
    this.stopSettings?.();
    this.stopSettings = null;
    this.sourceView = null;
  }

  /**
   * A display is an optional, read-only window. A malformed or partially loaded map must not
   * let a rendering error escape a store/settings subscription and disrupt the Atlas workspace.
   */
  private renderSafely(state: ViewAtlasState): void {
    try {
      this.render(state);
    } catch (error) {
      console.error('[Atlas] Could not update the Initiative Display:', error);
      this.contentEl.empty();
      this.contentEl.createDiv({
        cls: 'atlas-initiative-display__empty',
        text: 'The Initiative Display could not be updated. Check the developer console for details.',
      });
    }
  }

  private render(state: ViewAtlasState): void {
    const container = this.contentEl;
    const previousAnimationState = this.captureAnimationState(container);
    this.keyResizeObserver?.disconnect();
    this.keyResizeObserver = null;
    container.empty();
    const initiative = state.initiative;
    const root = container.createDiv({ cls: 'atlas-initiative-display' });
    root.dataset.font = this.sourceView?.serviceManager.getSettingsService().getInitiativeDisplayFont() ?? 'default';

    if (!initiative?.isActive) {
      this.combatWasActive = false;
      root.createDiv({ cls: 'atlas-initiative-display__empty', text: 'No active encounter' });
      return;
    }

    const lookup = rulesLookup(this.app);
    const definitions = mapResources(lookup, state.mapPath);
    const conditions = mapConditions(lookup, state.mapPath);
    const rules = mapInitiativeRules(this.app, state.mapPath ?? null);
    const tokens = state.objects?.tokens ?? {};
    const sides = sideIdsOf(initiative, rules);
    const visible = initiative.entries
      .slice()
      .sort((a, b) => a.order - b.order)
      .flatMap((entry): VisibleCombatant[] => {
        const tokenView = playersEntryToken(entry, tokens, definitions, conditions, sides);
        if (!tokenView) return [];
        const token = entry.tokenId ? tokens[entry.tokenId] : undefined;
        return [{ entry, token, playerToken: tokenView }];
      });

    const defeated = defeatedCombatants(initiative.entries, tokens, definitions);
    const holders = turnEntries(currentTurn(initiative), initiative, tokens, defeated);
    const holderIds = new Set(holders.map((entry) => entry.id));
    const active = visible.filter(({ entry }) => holderIds.has(entry.id));
    const displaySettings = this.sourceView?.serviceManager.getSettingsService();
    const conditionKeyMode = displaySettings?.getInitiativeDisplayConditionKeyMode() ?? 'dynamic';
    const conditionKeyPosition = displaySettings?.getInitiativeDisplayConditionKeyPosition() ?? 'top-right';
    const showHpBar = displaySettings?.showsInitiativeDisplayHpBar() ?? true;
    const showHpValue = displaySettings?.showsInitiativeDisplayHpValue() ?? true;
    if (active.length === 0) {
      if (conditionKeyMode === 'complete') this.renderConditionKey(root, [], conditions, conditionKeyMode);
      this.watchConditionKeyLayout(root, conditionKeyPosition);
      root.createDiv({ cls: 'atlas-initiative-display__empty', text: 'No visible combatant currently holds the turn' });
      root.createDiv({ cls: 'atlas-initiative-display__round', text: t('playerInit.round', { round: initiative.round }) });
      return;
    }

    const playStartup = this.startupPending || !this.combatWasActive;
    this.startupPending = false;
    this.combatWasActive = true;
    const current = active[0];
    const lastActiveIndex = Math.max(...active.map((combatant) => visible.findIndex(({ entry }) => entry.id === combatant.entry.id)));
    const next = visible[(lastActiveIndex + 1) % visible.length];
    const settings = this.sourceView?.serviceManager.getSettingsService().getLocalPlayerViewSettings();
    const playersSeeNames = settings?.showTokenNameplates ?? false;
    const mapShowsNameplates = state.tokenSettings?.showNameplates ?? false;

    // On a player character's turn, show the conditions affecting the player party.
    // On an enemy's turn, show only that enemy's conditions; listing every enemy's
    // conditions would add noise when the party is waiting to act.
    const conditionSubjects = conditionKeyMode === 'active'
      ? visible
      : current.entry.isNPC
        ? [current]
        : visible.filter(({ entry }) => !entry.isNPC);
    if (conditionKeyMode !== 'off') this.renderConditionKey(root, conditionSubjects, conditions, conditionKeyMode);
    root.createDiv({ cls: 'atlas-initiative-display__round', text: t('playerInit.round', { round: initiative.round }) });
    const stage = root.createDiv({ cls: 'atlas-initiative-display__stage' });
    const currentPanel = stage.createDiv({ cls: 'atlas-initiative-display__current' });
    this.renderCombatant(currentPanel, current, definitions, mapShowsNameplates, playersSeeNames, true, showHpBar, showHpValue);
    if (next && next.entry.id !== current.entry.id) {
      const nextPanel = stage.createDiv({ cls: 'atlas-initiative-display__next' });
      nextPanel.createDiv({ cls: 'atlas-initiative-display__next-label', text: 'Next' });
      this.renderCombatant(nextPanel, next, definitions, mapShowsNameplates, playersSeeNames, false, showHpBar, showHpValue);
    }
    this.watchConditionKeyLayout(root, conditionKeyPosition);
    if (playStartup) {
      this.playStartupAnimations(root);
    } else this.playContinuousAnimations(root, previousAnimationState);
  }

  /** Shows a compact key for the conditions currently affecting player-visible combatants. */
  private renderConditionKey(
    root: HTMLElement,
    combatants: VisibleCombatant[],
    definitions: ReturnType<typeof mapConditions>,
    mode: 'dynamic' | 'active' | 'complete',
  ): void {
    const activeById = new Map<string, NonNullable<EntryToken['conditions']>[number]>();
    for (const combatant of combatants) {
      for (const condition of combatant.playerToken.conditions ?? []) {
        if (!activeById.has(condition.id)) activeById.set(condition.id, condition);
      }
    }
    const displayConditions = mode === 'complete'
      ? definitions.map((definition) => {
        const parsedColor = Number.parseInt(definition.color.replace('#', ''), 16);
        return {
          id: definition.id,
          name: definition.name,
          color: Number.isNaN(parsedColor) ? 0x808080 : parsedColor,
          glyph: conditionGlyph(definition),
        };
      })
      : [...activeById.values()];
    if (displayConditions.length === 0) return;

    const key = root.createDiv({
      cls: 'atlas-initiative-display__condition-key',
      attr: { role: 'group', 'aria-label': mode === 'complete' ? 'Complete condition list' : 'Active condition key' },
    });
    key.createDiv({ cls: 'atlas-initiative-display__condition-key-title', text: 'Conditions' });
    const appendItem = (condition: typeof displayConditions[number]): void => {
      const item = key.createDiv({ cls: 'atlas-initiative-display__condition-key-item', attr: { 'data-condition-id': condition.id } });
      const symbol = item.createDiv({ cls: 'atlas-initiative-display__condition-key-symbol', attr: { 'aria-hidden': 'true' } });
      symbol.style.setProperty('--atlas-condition-color', `#${condition.color.toString(16).padStart(6, '0')}`);
      symbol.style.setProperty('--atlas-condition-glyph-color', isLightBadgeColor(condition.color) ? '#16161a' : '#fff');
      if (condition.glyph.kind === 'icon') {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 512 512');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', WIDGET_ICON_PATHS[condition.glyph.icon]);
        path.setAttribute('fill', isLightBadgeColor(condition.color) ? '#16161a' : '#fff');
        svg.append(path);
        symbol.append(svg);
      } else {
        symbol.createSpan({ cls: 'atlas-initiative-display__condition-key-glyph', text: condition.glyph.text });
      }
      item.createDiv({ cls: 'atlas-initiative-display__condition-key-name', text: condition.name });
    };
    for (const condition of displayConditions) appendItem(condition);
    // A ResizeObserver recalculates how many rows fit as the popout is resized.
  }


  /** Capture the previous layout before render replaces the DOM, so live updates can use FLIP motion. */
  private captureAnimationState(container: HTMLElement): InitiativeDisplayAnimationSnapshot {
    const badgeRects = new Map<string, { left: number; top: number; width: number; height: number }>();
    const portraitRects = new Map<string, { left: number; top: number; width: number; height: number }>();
    const conditionKeyIds = new Set<string>();
    container.querySelectorAll<HTMLElement>('[data-animation-key]').forEach((badge) => {
      const key = badge.dataset.animationKey;
      if (!key) return;
      const rect = badge.getBoundingClientRect();
      badgeRects.set(key, { left: rect.left, top: rect.top, width: rect.width, height: rect.height });
    });
    container.querySelectorAll<HTMLElement>('.atlas-initiative-display__portrait[data-combatant-id]').forEach((portrait) => {
      const id = portrait.dataset.combatantId;
      if (!id) return;
      const rect = portrait.getBoundingClientRect();
      portraitRects.set(id, { left: rect.left, top: rect.top, width: rect.width, height: rect.height });
    });
    container.querySelectorAll<HTMLElement>('.atlas-initiative-display__condition-key-item[data-condition-id]').forEach((item) => {
      const id = item.dataset.conditionId;
      if (id) conditionKeyIds.add(id);
    });
    return { badgeRects, portraitRects, conditionKeyIds };
  }

  /** Startup is deliberately a single ordered sequence, never replayed by later store updates. */
  private playStartupAnimations(root: HTMLElement): void {
    const view = root.ownerDocument.defaultView;
    if (!view || view.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const round = root.querySelector<HTMLElement>('.atlas-initiative-display__round');
    const current = root.querySelector<HTMLElement>('.atlas-initiative-display__current .atlas-initiative-display__portrait');
    const currentBadges = Array.from(root.querySelectorAll<HTMLElement>('.atlas-initiative-display__current [data-animation-key]'))
      .sort((a, b) => Number(a.dataset.conditionOrder) - Number(b.dataset.conditionOrder));
    const next = root.querySelector<HTMLElement>('.atlas-initiative-display__next .atlas-initiative-display__portrait');
    const nextLabel = root.querySelector<HTMLElement>('.atlas-initiative-display__next-label');
    const key = root.querySelector<HTMLElement>('.atlas-initiative-display__condition-key');
    const hp = root.querySelector<HTMLElement>('.atlas-initiative-display__resource--hp');

    // Match Atlas' "Combat has started" treatment: the heading resolves from a soft blur
    // while its letter spacing settles. Here it travels from screen centre to its resting top anchor.
    if (round) {
      const roundRect = round.getBoundingClientRect();
      const rootRect = root.getBoundingClientRect();
      const centerOffset = rootRect.top + (rootRect.height - roundRect.height) / 2 - roundRect.top;

      // The title travels to its anchor with ease-in, while its type resolves like Atlas' fight-start title.
      round.animate(
        [
          { transform: `translate(-50%, ${centerOffset}px)` },
          { transform: 'translate(-50%, 0)' },
        ],
        { duration: 900, easing: 'ease-in', fill: 'both' },
      );
      round.animate(
        [
          { opacity: 0, filter: 'blur(8px)', letterSpacing: '0.32em' },
          { opacity: 1, filter: 'blur(0)', letterSpacing: '0.04em' },
        ],
        { duration: 1000, delay: 80, easing: 'cubic-bezier(0.23, 1, 0.32, 1)', fill: 'both' },
      );
    }

    const currentStart = 900;
    current?.animate(
      [
        { opacity: 0, transform: 'scale(0.58) rotate(-9deg)', filter: 'blur(5px)' },
        { opacity: 1, transform: 'scale(1) rotate(0)', filter: 'blur(0)' },
      ],
      { duration: 520, delay: currentStart, easing: 'cubic-bezier(0.3, 1.45, 0.5, 1)', fill: 'both' },
    );

    const conditionStart = currentStart + 520;
    const conditionStagger = 105;
    currentBadges.forEach((badge, index) => {
      badge.animate(
        [
          { opacity: 0, transform: 'translate(-50%, -50%) scale(0.18) rotate(-24deg)', filter: 'blur(3px)' },
          { opacity: 1, transform: 'translate(-50%, -50%) scale(1) rotate(0)', filter: 'blur(0)' },
        ],
        { duration: 420, delay: conditionStart + index * conditionStagger, easing: 'cubic-bezier(0.44, -0.35, 0.31, 1.35)', fill: 'both' },
      );
    });

    const conditionsEnd = conditionStart + Math.max(0, currentBadges.length - 1) * conditionStagger + 420;
    const nextStart = conditionsEnd + 100;
    next?.animate(
      [
        { opacity: 0, transform: 'scale(0.62) rotate(8deg)', filter: 'blur(5px)' },
        { opacity: 1, transform: 'scale(1) rotate(0)', filter: 'blur(0)' },
      ],
      { duration: 500, delay: nextStart, easing: 'cubic-bezier(0.3, 1.45, 0.5, 1)', fill: 'both' },
    );

    const nextEnd = next ? nextStart + 500 : conditionsEnd;
    nextLabel?.animate(
      [
        { opacity: 0, transform: 'translateY(8px)', filter: 'blur(3px)' },
        { opacity: 1, transform: 'translateY(0)', filter: 'blur(0)' },
      ],
      { duration: 320, delay: nextEnd, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'both' },
    );

    const nextLabelEnd = nextLabel ? nextEnd + 320 : nextEnd;
    const keyStart = nextLabelEnd + 100;
    key?.animate(
      [
        { opacity: 0, transform: 'scale(0.88) translateY(12px)', filter: 'blur(3px)' },
        { opacity: 1, transform: 'scale(1) translateY(0)', filter: 'blur(0)' },
      ],
      { duration: 420, delay: keyStart, easing: 'cubic-bezier(0.3, 1.35, 0.5, 1)', fill: 'both' },
    );
    key?.querySelectorAll<HTMLElement>('.atlas-initiative-display__condition-key-item').forEach((item, index) => {
      item.animate(
        [
          { opacity: 0, transform: 'translateY(7px) scale(0.82)' },
          { opacity: 1, transform: 'translateY(0) scale(1)' },
        ],
        { duration: 300, delay: keyStart + 70 + index * 45, easing: 'cubic-bezier(0.3, 1.3, 0.5, 1)', fill: 'both' },
      );
    });

    const keyItemCount = key?.querySelectorAll('.atlas-initiative-display__condition-key-item').length ?? 0;
    const keyItemsEnd = 70 + Math.max(0, keyItemCount - 1) * 45 + 300;
    const keyEnd = keyStart + Math.max(420, keyItemsEnd);
    hp?.animate(
      [
        { opacity: 0, filter: 'blur(3px)' },
        { opacity: 1, filter: 'blur(0)' },
      ],
      { duration: 460, delay: keyEnd + 110, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', fill: 'both' },
    );
  }

  /** Animate only what changed during combat; existing badges glide into their new slots. */
  private playContinuousAnimations(root: HTMLElement, previous: InitiativeDisplayAnimationSnapshot): void {
    const view = root.ownerDocument.defaultView;
    if (!view || view.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    root.querySelectorAll<HTMLElement>('.atlas-initiative-display__portrait[data-combatant-id]').forEach((portrait) => {
      const id = portrait.dataset.combatantId;
      if (!id) return;
      const oldRect = previous.portraitRects.get(id);
      const rect = portrait.getBoundingClientRect();
      if (oldRect) {
        const dx = oldRect.left - rect.left;
        const dy = oldRect.top - rect.top;
        const scale = rect.width > 0 ? oldRect.width / rect.width : 1;
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5 || Math.abs(scale - 1) > 0.01) {
          portrait.animate(
            [
              { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, opacity: 0.82 },
              { transform: 'translate(0, 0) scale(1)', opacity: 1 },
            ],
            { duration: 480, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
          );
        }
      } else {
        portrait.animate(
          [
            { opacity: 0, transform: 'scale(0.62) rotate(-8deg)', filter: 'blur(5px)' },
            { opacity: 1, transform: 'scale(1) rotate(0)', filter: 'blur(0)' },
          ],
          { duration: 480, easing: 'cubic-bezier(0.3, 1.45, 0.5, 1)' },
        );
      }
    });

    root.querySelectorAll<HTMLElement>('[data-animation-key]').forEach((badge) => {
      const key = badge.dataset.animationKey;
      if (!key) return;
      const oldRect = previous.badgeRects.get(key);
      const rect = badge.getBoundingClientRect();
      if (oldRect) {
        const dx = oldRect.left - rect.left;
        const dy = oldRect.top - rect.top;
        const scale = rect.width > 0 ? oldRect.width / rect.width : 1;
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5 || Math.abs(scale - 1) > 0.01) {
          badge.animate(
            [
              { transform: `translate(-50%, -50%) translate(${dx}px, ${dy}px) scale(${scale})` },
              { transform: 'translate(-50%, -50%) translate(0, 0) scale(1)' },
            ],
            { duration: 380, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
          );
        }
      } else {
        badge.animate(
          [
            { opacity: 0, transform: 'translate(-50%, -50%) scale(0.2) rotate(-18deg)' },
            { opacity: 1, transform: 'translate(-50%, -50%) scale(1) rotate(0)' },
          ],
          { duration: 420, easing: 'cubic-bezier(0.3, 1.45, 0.5, 1)' },
        );
      }
    });

    root.querySelectorAll<HTMLElement>('.atlas-initiative-display__condition-key-item[data-condition-id]').forEach((item) => {
      const id = item.dataset.conditionId;
      if (!id || previous.conditionKeyIds.has(id)) return;
      const symbol = item.querySelector<HTMLElement>('.atlas-initiative-display__condition-key-symbol');
      const name = item.querySelector<HTMLElement>('.atlas-initiative-display__condition-key-name');
      symbol?.animate(
        [
          { opacity: 0, transform: 'scale(0.35) rotate(-14deg)' },
          { opacity: 1, transform: 'scale(1) rotate(0)' },
        ],
        { duration: 420, easing: 'cubic-bezier(0.3, 1.45, 0.5, 1)' },
      );
      // A left-to-right reveal gives the new label a write-on feel without changing its font.
      name?.animate(
        [{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0 0 0)' }],
        { duration: 520, easing: 'steps(14, end)' },
      );
    });
  }

  /** Keep the key in its selected corner while reserving space before the combatant. */
  private watchConditionKeyLayout(root: HTMLElement, position: 'top-left' | 'top-right' | 'bottom-left'): void {
    const key = root.querySelector<HTMLElement>('.atlas-initiative-display__condition-key');
    if (!key) return;
    key.classList.remove(
      'atlas-initiative-display__condition-key--top-left',
      'atlas-initiative-display__condition-key--top-right',
      'atlas-initiative-display__condition-key--bottom-left',
    );
    key.classList.add(`atlas-initiative-display__condition-key--${position}`);
    this.fitConditionKey(key, root, position);
    this.keyResizeObserver = new ResizeObserver(() => this.fitConditionKey(key, root, position));
    this.keyResizeObserver.observe(root);
  }

  /** Fits a two-column key to its visible items and the space clear of the portrait. */
  private fitConditionKey(
    key: HTMLElement,
    root: HTMLElement,
    position: 'top-left' | 'top-right' | 'bottom-left',
  ): void {
    const items = Array.from(key.querySelectorAll<HTMLElement>('.atlas-initiative-display__condition-key-item:not(.atlas-initiative-display__condition-key-overflow)'));
    const title = key.querySelector<HTMLElement>('.atlas-initiative-display__condition-key-title');
    if (!title || items.length === 0) return;

    const portrait = root.querySelector<HTMLElement>('.atlas-initiative-display__current .atlas-initiative-display__portrait');
    const rootRect = root.getBoundingClientRect();
    const style = getComputedStyle(key);
    const padding = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
    const rowGap = Number.parseFloat(style.rowGap) || 0;
    const titleHeight = title.getBoundingClientRect().height;
    // Use nearly all of the available display height. Do not impose an arbitrary
    // 70vh ceiling: the key should adapt to split-screen as well as fullscreen.
    let availableHeight = rootRect.height * 0.95;

    if (portrait) {
      const portraitRect = portrait.getBoundingClientRect();
      const keyRect = key.getBoundingClientRect();
      const clearance = Math.max(26, portraitRect.width * 0.15);
      const overlapsHorizontally = keyRect.left < portraitRect.right + clearance
        && keyRect.right > portraitRect.left - clearance;
      if (overlapsHorizontally && (position === 'top-left' || position === 'top-right')) {
        availableHeight = Math.min(availableHeight, portraitRect.top - keyRect.top - clearance);
      } else if (overlapsHorizontally && position === 'bottom-left') {
        availableHeight = Math.min(availableHeight, rootRect.bottom - portraitRect.bottom - clearance);
      }
    }

    // Keep condition symbols and text at their normal size. Use the full clear
    // vertical area instead; only show +n when there is genuinely no room for another row.
    const itemHeight = Math.max(30, ...items.map((item) => item.getBoundingClientRect().height));
    const rowHeight = itemHeight + rowGap;
    const maxRows = Math.max(1, Math.floor((Math.max(0, availableHeight - titleHeight - padding) + rowGap) / rowHeight));
    const maxCells = maxRows * 2;
    const overflowNeeded = items.length > maxCells;
    const visibleCount = overflowNeeded ? Math.max(0, maxCells - 1) : items.length;
    const hiddenCount = items.length - visibleCount;

    items.forEach((item, index) => { item.style.display = index < visibleCount ? 'flex' : 'none'; });
    key.querySelector('.atlas-initiative-display__condition-key-overflow')?.remove();
    if (hiddenCount > 0) {
      const overflow = key.createDiv({ cls: 'atlas-initiative-display__condition-key-item atlas-initiative-display__condition-key-overflow' });
      const symbol = overflow.createDiv({ cls: 'atlas-initiative-display__condition-key-symbol atlas-initiative-display__condition-key-symbol--overflow' });
      symbol.setText(`+${hiddenCount}`);
      overflow.createDiv({ cls: 'atlas-initiative-display__condition-key-name', text: 'more' });
    }

    // Grid rows are based on the items actually rendered, not the available maximum.
    const renderedCells = visibleCount + (hiddenCount > 0 ? 1 : 0);
    const actualRows = Math.max(1, Math.ceil(renderedCells / 2));
    key.style.setProperty('--atlas-condition-key-rows', String(actualRows));
    key.style.height = 'auto';
    key.style.maxHeight = 'none';
  }

  private renderCombatant(
    parent: HTMLElement,
    combatant: VisibleCombatant,
    definitions: ReturnType<typeof mapResources>,
    mapShowsNameplates: boolean,
    playersSeeNames: boolean,
    current: boolean,
    showHpBar: boolean,
    showHpValue: boolean,
  ): void {
    const { entry, token } = combatant;
    const card = parent.createDiv({ cls: current ? 'atlas-initiative-display__combatant atlas-initiative-display__combatant--current' : 'atlas-initiative-display__combatant atlas-initiative-display__combatant--next' });
    const avatar = card.createDiv({ cls: 'atlas-initiative-display__portrait' });
    const image = entry.imagePath ? portraitSrc(this.app, entry.imagePath) : null;
    if (image) avatar.createEl('img', { attr: { src: image, alt: '', draggable: 'false' } });
    else avatar.createDiv({ cls: 'atlas-initiative-display__portrait-placeholder', text: entry.isNPC ? '♟' : '●' });
    avatar.dataset.combatantId = entry.id;
    this.renderConditionBadges(avatar, combatant.playerToken.conditions ?? [], !current, entry.id);
    // Condition badges extend beyond the portrait's lower edge. Reserve the tested
    // responsive space in normal flow so the name and HP row remain clear.
    if ((combatant.playerToken.conditions?.length ?? 0) >= 3) {
      avatar.style.marginBottom = 'clamp(32px, 6.2vw, 80px)';
    }

    const name = nameShownToPlayers(entry.name, token ?? { showNameplate: false }, mapShowsNameplates, playersSeeNames);
    if (name) card.createDiv({ cls: 'atlas-initiative-display__name', text: name });

    if (current) {
      const resources = token ? visibleResources(token, definitions, 'player').filter(({ definition }) => showHpBar || definition.key !== 'hp') : [];
      // Atlas' player initiative list treats HP separately from ordinary resources. Mirror its
      // explicit visibility rule and use the player-safe HP value supplied by playersEntryToken.
      const hpDefinition = definitions.find((definition) => definition.key === 'hp' && definition.visibleToPlayers);
      if (showHpBar && hpDefinition && combatant.playerToken.hp && !resources.some(({ definition }) => definition.key === 'hp')) {
        resources.unshift({ definition: hpDefinition, value: combatant.playerToken.hp, slot: -1 });
      }
      if (resources.length > 0) {
        const stats = card.createDiv({
          cls: 'atlas-initiative-display__resources',
          attr: { role: 'group', 'aria-label': 'Visible combatant resources' },
        });
        for (const { definition, value } of resources) {
          const isHp = definition.key === 'hp';
          const resource = stats.createDiv({
            cls: isHp
              ? 'atlas-initiative-display__resource atlas-initiative-display__resource--hp'
              : 'atlas-initiative-display__resource',
          });
          resource.style.setProperty('--atlas-resource-color', definition.color);
          if (isHp) {
            resource.createDiv({ cls: 'atlas-initiative-display__hp-label', text: 'HP' });
            const track = resource.createDiv({
              cls: 'atlas-initiative-display__resource-track atlas-initiative-display__resource-track--hp',
              attr: {
                role: showHpValue ? 'meter' : 'img',
                'aria-label': definition.name,
                ...(showHpValue ? { 'aria-valuemin': '0', 'aria-valuemax': String(value.max), 'aria-valuenow': String(value.current) } : {}),
              },
            });
            const fill = track.createDiv({ cls: 'atlas-initiative-display__resource-fill' });
            fill.style.width = `${value.max > 0 ? Math.max(0, Math.min(100, (value.current / value.max) * 100)) : 0}%`;
            if (showHpValue) track.createDiv({ cls: 'atlas-initiative-display__hp-value', text: `${value.current} / ${value.max}` });
          } else {
            resource.createDiv({ cls: 'atlas-initiative-display__resource-heading' }, (heading) => {
              heading.createDiv({ cls: 'atlas-initiative-display__resource-name', text: definition.name });
              heading.createDiv({
                cls: 'atlas-initiative-display__resource-value',
                text: definition.direction === 'static' ? String(value.max) : `${value.current} / ${value.max}`,
              });
            });
            if (definition.direction !== 'static' && value.max > 0) {
              const track = resource.createDiv({
                cls: 'atlas-initiative-display__resource-track',
                attr: { role: 'meter', 'aria-label': definition.name, 'aria-valuemin': '0', 'aria-valuemax': String(value.max), 'aria-valuenow': String(value.current) },
              });
              const fill = track.createDiv({ cls: 'atlas-initiative-display__resource-fill' });
              fill.style.width = `${Math.max(0, Math.min(100, (value.current / value.max) * 100))}%`;
            }
          }
        }
      }
    }
  }

  /** Draws the same coloured circular glyph badges Atlas places along a token's upper-left ring. */
  private renderConditionBadges(parent: HTMLElement, conditions: NonNullable<EntryToken['conditions']>, compact = false, combatantId = ''): void {
    if (conditions.length === 0) return;
    const badgeLayer = parent.createDiv({
      cls: 'atlas-initiative-display__condition-ring',
      attr: { role: 'group', 'aria-label': `Active conditions: ${conditions.map(({ name }) => name).join(', ')}` },
    });
    const shown = conditions.length <= 11
      ? conditions
      : [...conditions.slice(0, 11), { id: 'overflow', name: `+${conditions.length - 11}`, color: 0x4a4a54, glyph: { kind: 'text' as const, text: `+${conditions.length - 11}` } }];
    // Distribute the existing badge slots evenly around the full token circumference.
    // Keep the same radius and badge sizing; only change the angular positions.
    shown.forEach((condition, index) => {
      const angle = shown.length === 2
        ? (index === 0 ? -Math.PI / 4 : -3 * Math.PI / 4)
        : -Math.PI / 2 + index * (Math.PI * 2 / shown.length);
      const isOverflow = condition.id === 'overflow';
      const badge = badgeLayer.createDiv({
        cls: compact
          ? 'atlas-initiative-display__condition-badge atlas-initiative-display__condition-badge--dot'
          : isOverflow
            ? 'atlas-initiative-display__condition-badge atlas-initiative-display__condition-badge--overflow'
            : 'atlas-initiative-display__condition-badge',
        attr: { title: condition.name, 'data-animation-key': `${combatantId}:${condition.id}` },
      });
      badge.style.setProperty('--atlas-condition-color', `#${condition.color.toString(16).padStart(6, '0')}`);
      badge.style.setProperty('--atlas-condition-glyph-color', isLightBadgeColor(condition.color) ? '#16161a' : '#fff');
      badge.style.setProperty('--atlas-condition-x', `${50 + Math.cos(angle) * 62}%`);
      badge.style.setProperty('--atlas-condition-y', `${50 + Math.sin(angle) * 62}%`);
      const clockwiseOrder = (angle - Math.PI + Math.PI * 2) % (Math.PI * 2);
      badge.dataset.conditionOrder = String(clockwiseOrder);
      if (!compact) {
        const light = isLightBadgeColor(condition.color);
        const glyphColor = light ? '#16161a' : '#fff';
        if (condition.glyph.kind === 'icon') {
          const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          svg.setAttribute('viewBox', '0 0 512 512');
          svg.setAttribute('aria-hidden', 'true');
          const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          path.setAttribute('d', WIDGET_ICON_PATHS[condition.glyph.icon]);
          path.setAttribute('fill', glyphColor);
          svg.append(path);
          badge.append(svg);
        } else {
          badge.createSpan({ cls: 'atlas-initiative-display__condition-glyph', text: condition.glyph.text });
        }
        if (condition.value !== undefined) {
          badge.createSpan({ cls: 'atlas-initiative-display__condition-value', text: String(condition.value) });
        }
      }
    });
  }
}
