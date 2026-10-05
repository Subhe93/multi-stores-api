import type { ThemePreset, ThemePresetSummary } from './types';
import { toSummary } from './shared';
import { marketFreshPreset } from './market-fresh';
import { editorialSerifPreset } from './editorial-serif';
import { boldStreetPreset } from './bold-street';
import { classicHeritagePreset } from './classic-heritage';
import { nordicCalmPreset } from './nordic-calm';
import { midnightPreset } from './midnight';

// Code-defined catalog, in gallery display order.
export const THEME_PRESETS: readonly ThemePreset[] = [
  marketFreshPreset,
  editorialSerifPreset,
  boldStreetPreset,
  classicHeritagePreset,
  nordicCalmPreset,
  midnightPreset,
];

export function findPreset(id: string): ThemePreset | undefined {
  return THEME_PRESETS.find((p) => p.id === id);
}

export function listPresetSummaries(): ThemePresetSummary[] {
  return THEME_PRESETS.map(toSummary);
}

export { toSummary } from './shared';
export type * from './types';
