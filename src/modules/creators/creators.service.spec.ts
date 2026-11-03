import { NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../../prisma/prisma.service';
import { CreatorsService } from './creators.service';

// PUT /creators/me/onboarding-profile (onboarding wave 3): survey answers
// are merged into the stored profile; the sign-up card is kept.

function build(profile: unknown) {
  const updates: Array<Record<string, unknown>> = [];
  const prisma = {
    creator: {
      findUnique: jest.fn(() =>
        Promise.resolve(
          profile === 'missing'
            ? null
            : { id: 'c1', onboarding_profile: profile },
        ),
      ),
      update: jest.fn(
        ({ data }: { data: { onboarding_profile: Record<string, unknown> } }) => {
          updates.push(data.onboarding_profile);
          return Promise.resolve({ onboarding_profile: data.onboarding_profile });
        },
      ),
    },
  };
  return {
    service: new CreatorsService(prisma as unknown as PrismaService),
    updates,
  };
}

describe('CreatorsService.updateOnboardingProfile', () => {
  const now = new Date('2026-11-03T10:00:00.000Z');

  it('merges stage/sells/country (upper-cased) and stamps completed_at', async () => {
    const { service, updates } = build({ account_kind: 'marketplace' });
    const res = await service.updateOnboardingProfile(
      'u1',
      { stage: 'physical_shop', sells: 'both', country: 'se' },
      now,
    );
    expect(updates[0]).toEqual({
      account_kind: 'marketplace',
      stage: 'physical_shop',
      sells: 'both',
      country: 'SE',
      completed_at: '2026-11-03T10:00:00.000Z',
    });
    expect(res.onboarding_profile).toEqual(updates[0]);
  });

  it('leaves omitted keys as stored (partial update)', async () => {
    const { service, updates } = build({
      account_kind: 'independent',
      stage: 'starting',
      country: 'DE',
    });
    await service.updateOnboardingProfile('u1', { sells: 'own' }, now);
    expect(updates[0]).toMatchObject({
      account_kind: 'independent',
      stage: 'starting',
      country: 'DE',
      sells: 'own',
    });
  });

  it('starts from an empty object when nothing is stored', async () => {
    const { service, updates } = build(null);
    await service.updateOnboardingProfile('u1', { country: 'tr' }, now);
    expect(updates[0]).toEqual({
      country: 'TR',
      completed_at: '2026-11-03T10:00:00.000Z',
    });
  });

  it('404 CREATOR_PROFILE_NOT_FOUND without a creator row', async () => {
    const { service } = build('missing');
    await expect(
      service.updateOnboardingProfile('u1', { stage: 'agency' }, now),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
