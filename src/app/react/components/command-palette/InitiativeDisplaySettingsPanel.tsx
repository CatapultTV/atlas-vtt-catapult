import React, { useEffect, useState } from 'react';
import { SegmentedControl } from '../../../packages/components/primitives/SegmentedControl';
import { useAtlasUI } from '../../root/AtlasUIContext';
import { SettingsService } from '../../../services/SettingsService';
import { INITIATIVE_DISPLAY_FONT_OPTIONS, type InitiativeDisplayFont } from '../../../initiative-display-font';
import type { InitiativeDisplayConditionKeyMode, InitiativeDisplayConditionKeyPosition } from '../../../services/atlasSettings';
import { SettingChoiceRow } from './SettingRows';
import { t } from '../../../i18n';

/** Typeface for every label, name and resource value in the standalone Initiative Display. */
export function InitiativeDisplaySettingsPanel(): React.ReactElement {
  const { app } = useAtlasUI();
  const settings = SettingsService.forApp(app ?? undefined);
  const [font, setFont] = useState<InitiativeDisplayFont>(() => settings?.getInitiativeDisplayFont() ?? 'default');
  const [conditionKeyMode, setConditionKeyMode] = useState<InitiativeDisplayConditionKeyMode>(() => settings?.getInitiativeDisplayConditionKeyMode() ?? 'dynamic');
  const [conditionKeyPosition, setConditionKeyPosition] = useState<InitiativeDisplayConditionKeyPosition>(() => settings?.getInitiativeDisplayConditionKeyPosition() ?? 'top-right');

  useEffect(() => {
    if (!settings) return;
    setFont(settings.getInitiativeDisplayFont());
    setConditionKeyMode(settings.getInitiativeDisplayConditionKeyMode());
    setConditionKeyPosition(settings.getInitiativeDisplayConditionKeyPosition());
    return settings.onChange(() => {
      setFont(settings.getInitiativeDisplayFont());
      setConditionKeyMode(settings.getInitiativeDisplayConditionKeyMode());
      setConditionKeyPosition(settings.getInitiativeDisplayConditionKeyPosition());
    });
  }, [settings]);

  const options = INITIATIVE_DISPLAY_FONT_OPTIONS.map((option) => ({
    ...option,
    label: option.value === 'default'
      ? t('palette.initiativeDisplayFontDefault')
      : option.value === 'medieval'
        ? t('diceSettings.font.medieval')
        : t('diceSettings.font.scifi'),
  }));

  return (
    <div className="atlas-command-palette-panel">
      <div className="atlas-command-palette-panel-column">
        <SettingChoiceRow
          label={t('palette.initiativeDisplayFont')}
          hint={t('palette.initiativeDisplayFontHint')}
        >
          <SegmentedControl<InitiativeDisplayFont>
            value={font}
            options={options}
            ariaLabel={t('palette.initiativeDisplayFont')}
            onChange={(next) => settings?.setInitiativeDisplayFont(next)}
          />
        </SettingChoiceRow>
        <SettingChoiceRow
          label={t('palette.initiativeDisplayConditionKey')}
          hint={t('palette.initiativeDisplayConditionKeyHint')}
        >
          <SegmentedControl<InitiativeDisplayConditionKeyMode>
            value={conditionKeyMode}
            options={[
              { value: 'dynamic', label: t('palette.initiativeDisplayConditionKeyDynamic') },
              { value: 'active', label: t('palette.initiativeDisplayConditionKeyActive') },
              { value: 'complete', label: t('palette.initiativeDisplayConditionKeyComplete') },
            ]}
            ariaLabel={t('palette.initiativeDisplayConditionKey')}
            onChange={(next) => settings?.setInitiativeDisplayConditionKeyMode(next)}
          />
        </SettingChoiceRow>
        <SettingChoiceRow
          label={t('palette.initiativeDisplayConditionKeyPosition')}
          hint={t('palette.initiativeDisplayConditionKeyPositionHint')}
        >
          <SegmentedControl<InitiativeDisplayConditionKeyPosition>
            value={conditionKeyPosition}
            options={[
              { value: 'top-left', label: t('palette.initiativeDisplayConditionKeyTopLeft') },
              { value: 'top-right', label: t('palette.initiativeDisplayConditionKeyTopRight') },
              { value: 'bottom-left', label: t('palette.initiativeDisplayConditionKeyBottomLeft') },
            ]}
            ariaLabel={t('palette.initiativeDisplayConditionKeyPosition')}
            onChange={(next) => settings?.setInitiativeDisplayConditionKeyPosition(next)}
          />
        </SettingChoiceRow>
      </div>
    </div>
  );
}
