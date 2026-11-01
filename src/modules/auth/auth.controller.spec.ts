import { Test } from '@nestjs/testing';
import {
  ValidationPipe,
  UnauthorizedException,
  type INestApplication,
} from '@nestjs/common';
import request from 'supertest';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AllExceptionsFilter } from '../../common/filters/http-exception.filter';

// HTTP contract of the magic-link endpoints, with the same global pipe and
// filter as main.ts.
describe('AuthController magic-link endpoints (HTTP)', () => {
  let app: INestApplication;
  const auth = {
    magicLogin: jest.fn(),
    guestRegister: jest.fn(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      // forgot/reset-password use ThrottlerGuard directly.
      imports: [ThrottlerModule.forRoot([{ ttl: 60000, limit: 1000 }])],
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: auth }],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  const http = () => app.getHttpServer() as Parameters<typeof request>[0];

  afterAll(() => app.close());
  beforeEach(() => jest.resetAllMocks());

  it('POST /auth/magic-login → 200 with the login body', async () => {
    const body = {
      user: { id: 'u1', email: 'a@b.se', role: 'CUSTOMER', status: 'ACTIVE' },
      access_token: 'a',
      refresh_token: 'r',
    };
    auth.magicLogin.mockResolvedValue(body);
    const res = await request(http())
      .post('/auth/magic-login')
      .send({ token: 'tok' })
      .expect(200);
    expect(res.body).toEqual(body);
    expect(auth.magicLogin).toHaveBeenCalledWith('tok', {
      store_slug: undefined,
      hostname: undefined,
    });
  });

  it('POST /auth/magic-login → 401 MAGIC_LINK_INVALID', async () => {
    auth.magicLogin.mockRejectedValue(
      new UnauthorizedException({
        code: 'MAGIC_LINK_INVALID',
        message: 'This login link is invalid or has expired',
      }),
    );
    const res = await request(http())
      .post('/auth/magic-login')
      .send({ token: 'tok' })
      .expect(401);
    expect(res.body).toMatchObject({ code: 'MAGIC_LINK_INVALID' });
  });

  it('POST /auth/magic-login rejects an oversized or missing token with 400', async () => {
    await request(http())
      .post('/auth/magic-login')
      .send({ token: 'x'.repeat(300) })
      .expect(400);
    await request(http()).post('/auth/magic-login').send({}).expect(400);
    expect(auth.magicLogin).not.toHaveBeenCalled();
  });

  it('POST /auth/guest-register → 201 with the register body', async () => {
    auth.guestRegister.mockResolvedValue({
      user: { id: 'u1' },
      access_token: 'a',
      refresh_token: 'r',
    });
    const res = await request(http())
      .post('/auth/guest-register')
      .send({
        email: 'a@b.se',
        first_name: 'Anna',
        store_slug: 'namez',
        hostname: 'namez.shop',
        locale: 'sv',
      })
      .expect(201);
    expect((res.body as { access_token: string }).access_token).toBe('a');
  });

  it('POST /auth/guest-register rejects a password field and a bad email', async () => {
    await request(http())
      .post('/auth/guest-register')
      .send({ email: 'a@b.se', password: 'client-made' })
      .expect(400);
    await request(http())
      .post('/auth/guest-register')
      .send({ email: 'nope' })
      .expect(400);
    expect(auth.guestRegister).not.toHaveBeenCalled();
  });
});
