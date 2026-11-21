import React, { useEffect, useState } from 'react';
import { SegmentedControl } from '../../../packages/components/primitives/SegmentedControl';
import { useAtlasUI } from '../../root/AtlasUIContext';
import { SettingsService } from '../../../services/SettingsService';
import { INITIATIVE_DISPLAY_FONT_OPTIONS, type InitiativeDisplayFont } from '../../../initiative-display-font';
import { SettingChoiceRow } from './SettingRows';
import { t } from '../../../i18n';

/** Typeface for every label, name and resource value in the standalone Initiative Display. */
export function InitiativeDisplaySettingsPanel(): React.ReactElement {
  const { app } = useAtlasUI();
  const settings = SettingsService.forApp(app ?? undefined);
  const [font, setFont] = useState<InitiativeDisplayFont>(() => settings?.getInitiativeDisplayFont() ?? 'default');

  useEffect(() => {
    if (!settings) return;
    setFont(settings.getInitiativeDisplayFont());
    return settings.onChange(() => setFont(settings.getInitiativeDisplayFont()));
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
      </div>
    </div>
  );
}
