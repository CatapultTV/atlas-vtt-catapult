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
import { playersEntryToken, sideIdsOf } from './services/playerInitiativeList';
import { nameShownToPlayers } from './pixi/token-renderer/nameplateVisibility';
import { portraitSrc } from './utils/portraitSrc';
import type { TokenEntity } from './types';
import type { InitiativeEntry } from './types/initiativeTypes';
import type { ViewAtlasState } from './storeFactory';
import { t } from './i18n';
import './initiative-display.scss';

export const INITIATIVE_DISPLAY_VIEW_TYPE = 'atlas-vtt-initiative-display';

interface InitiativeDisplaySession {
  sourceViewId: string;
  sourceFilePath?: string;
}

/** A combatant after applying the same visibility rules as Atlas' player-facing initiative list. */
interface VisibleCombatant {
  entry: InitiativeEntry;
  token: TokenEntity | undefined;
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
    this.contentEl.doc.body.addClass('atlas-initiative-display-window');
    this.contentEl.setText('Connecting to the Atlas map…');
    this.registerEvent(this.app.workspace.on('layout-change', () => this.queueReconnect()));
    this.app.workspace.onLayoutReady(() => this.queueReconnect());
  }

  async onClose(): Promise<void> {
    this.disconnect();
    this.contentEl.doc.body.removeClass('atlas-initiative-display-window');
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

    this.stopStore = source.atlasStore.subscribe((state) => this.render(state));
    const settings = source.serviceManager.getSettingsService();
    this.stopSettings = settings.onChange(() => this.render(source.atlasStore.getState()));
    this.render(source.atlasStore.getState());
  }

  private disconnect(): void {
    this.stopStore?.();
    this.stopStore = null;
    this.stopSettings?.();
    this.stopSettings = null;
    this.sourceView = null;
  }

  private render(state: ViewAtlasState): void {
    const container = this.contentEl;
    container.empty();
    const initiative = state.initiative;
    const root = container.createDiv({ cls: 'atlas-initiative-display' });

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
        return [{ entry, token }];
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

    const name = nameShownToPlayers(entry.name, token ?? { showNameplate: false }, mapShowsNameplates, playersSeeNames);
    if (name) card.createDiv({ cls: 'atlas-initiative-display__name', text: name });

    if (current && token) {
      const resources = visibleResources(token, definitions, 'player');
      if (resources.length > 0) {
        const stats = card.createDiv({ cls: 'atlas-initiative-display__resources' });
        for (const { definition, value } of resources) {
          const resource = stats.createDiv({ cls: 'atlas-initiative-display__resource' });
          resource.createDiv({ cls: 'atlas-initiative-display__resource-name', text: definition.name });
          resource.createDiv({ cls: 'atlas-initiative-display__resource-value', text: `${value.current} / ${value.max}` });
        }
      }
    }
  }
}
