import type { Kit, KitSummary } from './types';
import { shoesModernKit } from './shoes-modern';
import { techMinimalKit } from './tech-minimal';
import { v1ceNfcKit } from './v1ce-nfc';
import { namezGiftsKit } from './namez-gifts';

// The template-kit catalog. Add a new kit by importing its definition here.
export const KITS: Kit[] = [shoesModernKit, techMinimalKit, v1ceNfcKit, namezGiftsKit];

export function listKitSummaries(): KitSummary[] {
  return KITS.map((k) => ({
    id: k.id,
    name: k.name,
    description: k.description,
    tags: k.tags,
    previewImage: k.previewImage,
  }));
}

export function findKit(id: string): Kit | undefined {
  return KITS.find((k) => k.id === id);
}

export type { Kit, KitSummary } from './types';
