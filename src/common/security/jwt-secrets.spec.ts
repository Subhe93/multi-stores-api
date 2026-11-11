import { JwtService } from '@nestjs/jwt';
import type { ConfigService } from '@nestjs/config';
import { JwtStrategy } from '../../modules/auth/strategies/jwt.strategy';
import type { PrismaService } from '../../prisma/prisma.service';
import { jwtSecrets, jwtSecretsProblem, verifyWithRotation } from './jwt-secrets';

// JWT secret rotation: tokens signed with the previous secret keep verifying
// while *_PREVIOUS is set; the grace window ends when it is removed.

const cfg = (env: Record<string, string | undefined>) =>
  ({ get: (k: string) => env[k] }) as unknown as ConfigService;

describe('jwtSecrets', () => {
  it('lists the current secret first, then a differing previous one', () => {
    expect(jwtSecrets(cfg({ JWT_SECRET: 'new', JWT_SECRET_PREVIOUS: 'old' }), 'access')).toEqual(['new', 'old']);
    expect(jwtSecrets(cfg({ JWT_SECRET: 'new' }), 'access')).toEqual(['new']);
    expect(jwtSecrets(cfg({ JWT_SECRET: 'same', JWT_SECRET_PREVIOUS: ' same ' }), 'access')).toEqual(['same']);
    expect(
      jwtSecrets(cfg({ JWT_REFRESH_SECRET: 'r2', JWT_REFRESH_SECRET_PREVIOUS: 'r1' }), 'refresh'),
    ).toEqual(['r2', 'r1']);
  });
});

describe('verifyWithRotation', () => {
  const jwt = new JwtService({});

  it('accepts a token signed with the previous secret during the grace window', async () => {
    const token = await jwt.signAsync({ sub: 'u1' }, { secret: 'old', expiresIn: '1h' });
    const payload = await verifyWithRotation<{ sub: string }>(
      jwt,
      cfg({ JWT_SECRET: 'new', JWT_SECRET_PREVIOUS: 'old' }),
      'access',
      token,
    );
    expect(payload.sub).toBe('u1');
  });

  it('rejects that token once the previous secret is removed', async () => {
    const token = await jwt.signAsync({ sub: 'u1' }, { secret: 'old', expiresIn: '1h' });
    await expect(
      verifyWithRotation(jwt, cfg({ JWT_SECRET: 'new' }), 'access', token),
    ).rejects.toMatchObject({ name: 'JsonWebTokenError' });
  });

  it('reports an expired current-secret token as expired, not as a bad signature', async () => {
    const token = await jwt.signAsync({ sub: 'u1' }, { secret: 'new', expiresIn: -10 });
    await expect(
      verifyWithRotation(jwt, cfg({ JWT_SECRET: 'new', JWT_SECRET_PREVIOUS: 'old' }), 'access', token),
    ).rejects.toMatchObject({ name: 'TokenExpiredError' });
  });

  it('keeps access and refresh secrets apart', async () => {
    const refresh = await jwt.signAsync({ sub: 'u1' }, { secret: 'r1', expiresIn: '1h' });
    const env = cfg({ JWT_SECRET: 'a2', JWT_SECRET_PREVIOUS: 'a1', JWT_REFRESH_SECRET: 'r2', JWT_REFRESH_SECRET_PREVIOUS: 'r1' });
    await expect(verifyWithRotation(jwt, env, 'access', refresh)).rejects.toBeTruthy();
    await expect(verifyWithRotation(jwt, env, 'refresh', refresh)).resolves.toMatchObject({ sub: 'u1' });
  });
});

describe('jwtSecretsProblem', () => {
  it('requires both current secrets and keeps every value distinct across kinds', () => {
    expect(jwtSecretsProblem({ JWT_SECRET: 'a', JWT_REFRESH_SECRET: 'r' })).toBeNull();
    expect(jwtSecretsProblem({ JWT_SECRET: 'a', JWT_REFRESH_SECRET: 'r', JWT_SECRET_PREVIOUS: 'a0', JWT_REFRESH_SECRET_PREVIOUS: 'r0' })).toBeNull();
    expect(jwtSecretsProblem({ JWT_SECRET: 'a' })).toMatch(/must both be set/);
    expect(jwtSecretsProblem({ JWT_SECRET: 'a', JWT_REFRESH_SECRET: 'a' })).toMatch(/must differ/);
    expect(jwtSecretsProblem({ JWT_SECRET: 'a', JWT_REFRESH_SECRET: 'r', JWT_REFRESH_SECRET_PREVIOUS: 'a' })).toMatch(/must not share/);
    expect(jwtSecretsProblem({ JWT_SECRET: 'a', JWT_REFRESH_SECRET: 'r', JWT_SECRET_PREVIOUS: 'r' })).toMatch(/must not share/);
  });
});

describe('JwtStrategy secret provider', () => {
  // Runs the strategy's secretOrKeyProvider the way passport-jwt does and
  // returns the secret it picked for the bearer token.
  const pick = async (env: Record<string, string | undefined>, token: string): Promise<string | undefined> => {
    const strategy = new JwtStrategy(cfg(env), {} as PrismaService, new JwtService({}));
    const provider = (strategy as unknown as { _secretOrKeyProvider: (req: unknown, raw: string, done: (e: unknown, s?: string) => void) => void })
      ._secretOrKeyProvider;
    return new Promise((resolve) => provider(undefined, token, (_e, s) => resolve(s)));
  };
  const jwt = new JwtService({});

  it('picks the previous secret for an old token and the current one otherwise', async () => {
    const env = { JWT_SECRET: 'new', JWT_SECRET_PREVIOUS: 'old' };
    const oldToken = await jwt.signAsync({ sub: 'u1' }, { secret: 'old', expiresIn: '1h' });
    const newToken = await jwt.signAsync({ sub: 'u1' }, { secret: 'new', expiresIn: '1h' });
    const garbage = 'x.y.z';
    expect(await pick(env, oldToken)).toBe('old');
    expect(await pick(env, newToken)).toBe('new');
    expect(await pick(env, garbage)).toBe('new');
    // Grace window over: the old token is verified against the current secret and fails.
    expect(await pick({ JWT_SECRET: 'new' }, oldToken)).toBe('new');
  });
});
