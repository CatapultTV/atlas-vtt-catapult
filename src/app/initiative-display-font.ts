/** Fonts available to every text element in the standalone Initiative Display. */
export type InitiativeDisplayFont = 'default' | 'medieval' | 'scifi';

export const INITIATIVE_DISPLAY_FONT_OPTIONS = [
  { value: 'default', label: 'Default' },
  { value: 'medieval', label: 'Medieval' },
  { value: 'scifi', label: 'Sci-fi' },
] as const;

export function isInitiativeDisplayFont(value: unknown): value is InitiativeDisplayFont {
  return value === 'default' || value === 'medieval' || value === 'scifi';
}
