import { ShippingMethodType } from '@prisma/client';
import { cleanText } from '../model/clean';
import { buildExternalRef } from '../model/external-ref';
import type {
  NormalizedCatalog,
  NShippingMethod,
  NShippingZone,
} from '../model/normalized';
import type { ImportRunOptions } from '../runs/run-options';
import { money } from './hash';
import { countriesOfContinent } from './continents';
import type { MapWarning } from './map-product';

/**
 * Woo shipping → `ShippingProfile` / `ShippingZone` / `ShippingMethod`
 * (M4.4 D26). Only when the bundle has the shipping tables (v1 export).
 * One profile for products without a class plus one per class used by an
 * imported product; every Woo zone (country / continent locations; zone 0
 * "rest of the world" is skipped) is copied into each profile.
 */

export const DEFAULT_PROFILE_KEY = 'default';

export interface MappedShippingMethod {
  ref: string;
  name: string;
  type: ShippingMethodType;
  base_cost: string;
  per_item_cost: string;
  free_threshold: string | null;
  estimated_days_min: number;
  estimated_days_max: number;
  is_active: true;
  sort_order: number;
}

export interface MappedShippingZone {
  ref: string;
  name: string;
  countries: string[];
  base_cost: string;
  per_item_cost: string;
  free_threshold: string | null;
  estimated_days_min: number;
  estimated_days_max: number;
  methods: MappedShippingMethod[];
}

export interface MappedShippingProfile {
  ref: string;
  /** Shipping class slug; null for the profile of products without a class. */
  class_slug: string | null;
  name: string;
  zones: MappedShippingZone[];
}

interface ParsedCost {
  base: number;
  perItem: number;
  formula: boolean;
}

function num(s: string): number | null {
  const t = s.trim().replace(',', '.');
  if (t === '') return 0;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Flat-rate cost: a constant, `[qty] * N`, `N * [qty]`, or `A + [qty] * N`; anything else is a formula. */
export function parseFlatRateCost(raw: unknown): ParsedCost {
  const s =
    typeof raw === 'string'
      ? raw.trim()
      : typeof raw === 'number'
        ? String(raw)
        : '';
  if (s === '') return { base: 0, perItem: 0, formula: false };
  const constant = num(s);
  if (constant !== null) return { base: constant, perItem: 0, formula: false };
  const m =
    /^\s*(?:([\d.,]+)\s*\+\s*)?(?:\[qty\]\s*\*\s*([\d.,]+)|([\d.,]+)\s*\*\s*\[qty\])\s*$/i.exec(
      s,
    );
  if (m) {
    const base = m[1] ? num(m[1]) : 0;
    const per = num(m[2] ?? m[3] ?? '');
    if (base !== null && per !== null)
      return { base, perItem: per, formula: false };
  }
  const lead = /^\s*([\d.,]+)/.exec(s);
  return { base: lead ? (num(lead[1]) ?? 0) : 0, perItem: 0, formula: true };
}

function zoneCountries(
  zone: NShippingZone,
  warn: (code: string, msg: string) => void,
): string[] {
  const out = new Set<string>();
  for (const loc of zone.locations) {
    if (loc.type === 'country') out.add(loc.code.toUpperCase().split(':')[0]);
    else if (loc.type === 'continent')
      countriesOfContinent(loc.code).forEach((c) => out.add(c));
    else
      warn(
        'W_SHIPPING_LOCATION_UNSUPPORTED',
        `zone "${zone.name}": ${loc.type} location ${loc.code} not supported (country only)`,
      );
  }
  return [...out].sort();
}

function settingString(m: NShippingMethod, key: string): string | null {
  const v = m.settings[key];
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null;
}

export function mapShipping(
  catalog: NormalizedCatalog,
  usedClassSlugs: Set<string>,
  options: ImportRunOptions,
  warnFn: (w: MapWarning) => void,
): MappedShippingProfile[] {
  const shipping = catalog.shipping;
  if (!shipping?.zones_available) return [];
  const host = catalog.meta.site_host;
  const warn = (code: string, message: string, ref = `woo:${host}:shipping`) =>
    warnFn({ code, external_ref: ref, title: 'shipping', message });
  const days = options.shipping.default_days;

  const classes = shipping.classes.filter((c) => usedClassSlugs.has(c.slug));
  const profiles: {
    ref: string;
    class_slug: string | null;
    name: string;
    classTermId: string | null;
  }[] = [
    {
      ref: buildExternalRef(host, 'shipping_class', DEFAULT_PROFILE_KEY),
      class_slug: null,
      name: 'Standard',
      classTermId: null,
    },
    ...classes.map((c) => ({
      ref: c.ext_id,
      class_slug: c.slug,
      name: cleanText(c.name) || c.slug,
      classTermId: c.ext_id.split(':').pop() ?? null,
    })),
  ];

  const result: MappedShippingProfile[] = [];
  for (const prof of profiles) {
    const zones: MappedShippingZone[] = [];
    for (const zone of shipping.zones) {
      const zoneId = zone.ext_id.split(':').pop();
      if (zoneId === '0') {
        if (prof.class_slug === null)
          warn(
            'W_SHIPPING_ZONE_SKIPPED',
            `zone "${zone.name}" (rest of the world) is not imported`,
            zone.ext_id,
          );
        continue;
      }
      const warnOnce = prof.class_slug === null ? warn : () => undefined;
      const countries = zoneCountries(zone, (c, m) =>
        warnOnce(c, m, zone.ext_id),
      );
      if (!countries.length) {
        warnOnce(
          'W_SHIPPING_ZONE_SKIPPED',
          `zone "${zone.name}" has no country locations`,
          zone.ext_id,
        );
        continue;
      }
      const zoneRef = `${zone.ext_id}#${prof.class_slug ?? DEFAULT_PROFILE_KEY}`;
      const enabled = zone.methods
        .filter((m) => m.enabled)
        .slice()
        .sort((a, b) => a.order - b.order);
      let freeThreshold: number | null = null;
      const methods: MappedShippingMethod[] = [];
      for (const m of enabled) {
        const name =
          options.shipping.method_names[m.method_id] ??
          (cleanText(settingString(m, 'title') ?? '') || m.method_id);
        const methodRef = `${zoneRef}#${m.instance_id}`;
        if (m.method_id === 'free_shipping') {
          const requires = settingString(m, 'requires') ?? '';
          const min = num(settingString(m, 'min_amount') ?? '');
          if ((requires === 'min_amount' || requires === 'either') && min) {
            if (options.shipping.free_shipping_as_threshold)
              freeThreshold = min;
            else
              warnOnce(
                'W_SHIPPING_METHOD_UNSUPPORTED',
                `free shipping over ${min} not imported`,
                zone.ext_id,
              );
          } else if (requires === '') {
            methods.push({
              ref: methodRef,
              name,
              type: ShippingMethodType.DELIVERY,
              base_cost: '0.00',
              per_item_cost: '0.00',
              free_threshold: null,
              estimated_days_min: days.min,
              estimated_days_max: days.max,
              is_active: true,
              sort_order: methods.length,
            });
          } else {
            warnOnce(
              'W_SHIPPING_METHOD_UNSUPPORTED',
              `free shipping "${requires}" (coupon) not imported`,
              zone.ext_id,
            );
          }
          continue;
        }
        if (m.method_id === 'flat_rate') {
          const cost = parseFlatRateCost(m.settings.cost);
          let base = cost.base;
          let per = cost.perItem;
          let formula = cost.formula;
          const extraKey = prof.classTermId
            ? `class_cost_${prof.classTermId}`
            : 'no_class_cost';
          const extra = parseFlatRateCost(m.settings[extraKey]);
          base += extra.base;
          per += extra.perItem;
          formula = formula || extra.formula;
          if (formula)
            warnOnce(
              'W_SHIPPING_COST_FORMULA',
              `zone "${zone.name}" ${name}: cost formula simplified to ${base}`,
              zone.ext_id,
            );
          methods.push({
            ref: methodRef,
            name,
            type: ShippingMethodType.DELIVERY,
            base_cost: money(base)!,
            per_item_cost: money(per)!,
            free_threshold: null,
            estimated_days_min: days.min,
            estimated_days_max: days.max,
            is_active: true,
            sort_order: methods.length,
          });
          continue;
        }
        if (
          m.method_id === 'local_pickup' ||
          m.method_id === 'pickup_location'
        ) {
          const cost = parseFlatRateCost(m.settings.cost);
          methods.push({
            ref: methodRef,
            name,
            type: ShippingMethodType.PICKUP,
            base_cost: money(cost.base)!,
            per_item_cost: '0.00',
            free_threshold: null,
            estimated_days_min: 0,
            estimated_days_max: 0,
            is_active: true,
            sort_order: methods.length,
          });
          continue;
        }
        warnOnce(
          'W_SHIPPING_METHOD_UNSUPPORTED',
          `zone "${zone.name}": method ${m.method_id} not imported`,
          zone.ext_id,
        );
      }
      if (freeThreshold !== null) {
        for (const m of methods)
          if (m.type === ShippingMethodType.DELIVERY)
            m.free_threshold = money(freeThreshold);
      }
      if (!methods.length) {
        warnOnce(
          'W_SHIPPING_ZONE_SKIPPED',
          `zone "${zone.name}" has no importable method`,
          zone.ext_id,
        );
        continue;
      }
      const firstDelivery =
        methods.find((m) => m.type === ShippingMethodType.DELIVERY) ??
        methods[0];
      zones.push({
        ref: zoneRef,
        name: cleanText(zone.name) || 'Zone',
        countries,
        base_cost: firstDelivery.base_cost,
        per_item_cost: firstDelivery.per_item_cost,
        free_threshold: firstDelivery.free_threshold,
        estimated_days_min: firstDelivery.estimated_days_min,
        estimated_days_max: firstDelivery.estimated_days_max,
        methods,
      });
    }
    result.push({
      ref: prof.ref,
      class_slug: prof.class_slug,
      name: prof.name,
      zones,
    });
  }
  return result;
}
