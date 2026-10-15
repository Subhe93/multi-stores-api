import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { ViesService } from './vies.service';
import { FetchViesHttpClient } from './vies.client';

// Opt-in smoke test against the real VIES *test service* (no production
// lookups): VIES_LIVE_TEST=1 npx jest vies.live. Skipped otherwise, so the
// normal suite never touches the network.

const live = process.env.VIES_LIVE_TEST === '1' ? describe : describe.skip;

live('VIES test service (live)', () => {
  it('number 100 is valid, 200 invalid', async () => {
    const prisma = {
      vatNumberCheck: {
        findFirst: () => Promise.resolve(null),
        create: () => Promise.resolve({ id: 'live' }),
      },
    };
    const service = new ViesService(
      prisma as unknown as PrismaService,
      {
        get: (k: string) =>
          k === 'VIES_BASE_URL'
            ? 'https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-test-service'
            : undefined,
      } as unknown as ConfigService,
      new FetchViesHttpClient(),
    );
    const valid = await service.check('LU100', {
      source: 'dashboard',
      mode: 'live',
    });
    expect(valid).toMatchObject({ status: 'valid', valid: true });
    const invalid = await service.check('LU200', {
      source: 'dashboard',
      mode: 'live',
    });
    expect(invalid.status).toBe('invalid');
  }, 15_000);
});
