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
import { isLightBadgeColor } from './utils/conditionGlyph';
import { portraitSrc } from './utils/portraitSrc';
import type { TokenEntity } from './types';
import type { InitiativeEntry } from './types/initiativeTypes';
import type { ViewAtlasState } from './storeFactory';
import { t } from './i18n';
import './initiative-display.scss';

/** Identifies stylesheet nodes so the popout does not receive duplicate styles. */
function initiativeStyleNodeKey(node: Element): string {
  return node instanceof HTMLLinkElement ? `link:${node.href}` : `style:${node.textContent ?? ''}`;
}

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
    // Follow Atlas' LocalPlayerView pattern: only mark a separate Obsidian popout window.
    if (this.contentEl.win !== window) {
      const doc = this.contentEl.doc;
      this.copyMainWindowStyles(doc);
      doc.body.addClass('atlas-initiative-display-window');
    }
    this.contentEl.setText('Connecting to the Atlas map…');
    this.registerEvent(this.app.workspace.on('layout-change', () => this.queueReconnect()));
    this.app.workspace.onLayoutReady(() => this.queueReconnect());
  }

  async onClose(): Promise<void> {
    this.disconnect();
    this.contentEl.doc.body.removeClass('atlas-initiative-display-window');
    this.contentEl.empty();
  }

  /** Mirrors the main window's stylesheets into the popout, skipping styles already present. */
  private copyMainWindowStyles(doc: Document): void {
    const existing = new Set(
      Array.from(doc.head.querySelectorAll('link[rel=\"stylesheet\"], style')).map(initiativeStyleNodeKey),
    );
    document.head.querySelectorAll('link[rel=\"stylesheet\"], style').forEach((node) => {
      if (existing.has(initiativeStyleNodeKey(node))) return;
      doc.head.appendChild(doc.importNode(node, true));
    });
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
    container.empty();
    const initiative = state.initiative;
    const root = container.createDiv({ cls: 'atlas-initiative-display' });
    root.dataset.font = this.sourceView?.serviceManager.getSettingsService().getInitiativeDisplayFont() ?? 'default';

    if (!initiative?.isActive) {
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
    if (active.length === 0) {
      root.createDiv({ cls: 'atlas-initiative-display__empty', text: 'No visible combatant currently holds the turn' });
      root.createDiv({ cls: 'atlas-initiative-display__round', text: t('playerInit.round', { round: initiative.round }) });
      return;
    }

    const current = active[0];
    const lastActiveIndex = Math.max(...active.map((combatant) => visible.findIndex(({ entry }) => entry.id === combatant.entry.id)));
    const next = visible[(lastActiveIndex + 1) % visible.length];
    const settings = this.sourceView?.serviceManager.getSettingsService().getLocalPlayerViewSettings();
    const playersSeeNames = settings?.showTokenNameplates ?? false;
    const mapShowsNameplates = state.tokenSettings?.showNameplates ?? false;

    root.createDiv({ cls: 'atlas-initiative-display__round', text: t('playerInit.round', { round: initiative.round }) });
    const stage = root.createDiv({ cls: 'atlas-initiative-display__stage' });
    const currentPanel = stage.createDiv({ cls: 'atlas-initiative-display__current' });
    this.renderCombatant(currentPanel, current, definitions, mapShowsNameplates, playersSeeNames, true);
    if (next && next.entry.id !== current.entry.id) {
      const nextPanel = stage.createDiv({ cls: 'atlas-initiative-display__next' });
      nextPanel.createDiv({ cls: 'atlas-initiative-display__next-label', text: 'Next' });
      this.renderCombatant(nextPanel, next, definitions, mapShowsNameplates, playersSeeNames, false);
    }
  }

  private renderCombatant(
    parent: HTMLElement,
    combatant: VisibleCombatant,
    definitions: ReturnType<typeof mapResources>,
    mapShowsNameplates: boolean,
    playersSeeNames: boolean,
    current: boolean,
  ): void {
    const { entry, token } = combatant;
    const card = parent.createDiv({ cls: current ? 'atlas-initiative-display__combatant atlas-initiative-display__combatant--current' : 'atlas-initiative-display__combatant atlas-initiative-display__combatant--next' });
    const avatar = card.createDiv({ cls: 'atlas-initiative-display__portrait' });
    const image = entry.imagePath ? portraitSrc(this.app, entry.imagePath) : null;
    if (image) avatar.createEl('img', { attr: { src: image, alt: '', draggable: 'false' } });
    else avatar.createDiv({ cls: 'atlas-initiative-display__portrait-placeholder', text: entry.isNPC ? '♟' : '●' });
    this.renderConditionBadges(avatar, combatant.playerToken.conditions ?? []);

    const name = nameShownToPlayers(entry.name, token ?? { showNameplate: false }, mapShowsNameplates, playersSeeNames);
    if (name) card.createDiv({ cls: 'atlas-initiative-display__name', text: name });

    if (current) {
      const resources = token ? visibleResources(token, definitions, 'player') : [];
      // Atlas' player initiative list treats HP separately from ordinary resources. Mirror its
      // explicit visibility rule and use the player-safe HP value supplied by playersEntryToken.
      const hpDefinition = definitions.find((definition) => definition.key === 'hp' && definition.visibleToPlayers);
      if (hpDefinition && combatant.playerToken.hp && !resources.some(({ definition }) => definition.key === 'hp')) {
        resources.unshift({ definition: hpDefinition, value: combatant.playerToken.hp, slot: -1 });
      }
      if (resources.length > 0) {
        const stats = card.createDiv({
          cls: 'atlas-initiative-display__resources',
          attr: { role: 'group', 'aria-label': 'Visible combatant resources' },
        });
        for (const { definition, value } of resources) {
          const isHp = definition.key === 'hp';
          const resource = stats.createDiv({ cls: isHp ? 'atlas-initiative-display__resource atlas-initiative-display__resource--hp' : 'atlas-initiative-display__resource' });
          resource.style.setProperty('--atlas-resource-color', definition.color);
          if (isHp) {
            resource.createDiv({ cls: 'atlas-initiative-display__hp-label', text: 'HP' });
            const track = resource.createDiv({
              cls: 'atlas-initiative-display__resource-track atlas-initiative-display__resource-track--hp',
              attr: { role: 'meter', 'aria-label': definition.name, 'aria-valuemin': '0', 'aria-valuemax': String(value.max), 'aria-valuenow': String(value.current) },
            });
            const fill = track.createDiv({ cls: 'atlas-initiative-display__resource-fill' });
            fill.style.width = `${value.max > 0 ? Math.max(0, Math.min(100, (value.current / value.max) * 100)) : 0}%`;
            track.createDiv({ cls: 'atlas-initiative-display__hp-value', text: `${value.current} / ${value.max}` });
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
  private renderConditionBadges(parent: HTMLElement, conditions: NonNullable<EntryToken['conditions']>): void {
    if (conditions.length === 0) return;
    const badgeLayer = parent.createDiv({
      cls: 'atlas-initiative-display__condition-ring',
      attr: { role: 'group', 'aria-label': `Active conditions: ${conditions.map(({ name }) => name).join(', ')}` },
    });
    const shown = conditions.length <= 6
      ? conditions
      : [...conditions.slice(0, 5), { id: 'overflow', name: `+${conditions.length - 5}`, color: 0x4a4a54, glyph: { kind: 'text' as const, text: `+${conditions.length - 5}` } }];
    // Use fixed slots starting at the top and curving left. The overflow badge therefore
    // stays in the same place regardless of the selected display font or condition count.
    shown.forEach((condition, index) => {
      const angle = -Math.PI / 2 - index * (Math.PI / 2 / 5);
      const isOverflow = condition.id === 'overflow';
      const badge = badgeLayer.createDiv({
        cls: isOverflow
          ? 'atlas-initiative-display__condition-badge atlas-initiative-display__condition-badge--overflow'
          : 'atlas-initiative-display__condition-badge',
        attr: { title: condition.name },
      });
      badge.style.setProperty('--atlas-condition-color', `#${condition.color.toString(16).padStart(6, '0')}`);
      badge.style.setProperty('--atlas-condition-glyph-color', isLightBadgeColor(condition.color) ? '#16161a' : '#fff');
      badge.style.setProperty('--atlas-condition-x', `${50 + Math.cos(angle) * 62}%`);
      badge.style.setProperty('--atlas-condition-y', `${50 + Math.sin(angle) * 62}%`);
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
    });
  }
}
