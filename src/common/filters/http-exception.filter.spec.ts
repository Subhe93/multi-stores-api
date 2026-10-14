import {
  ArgumentsHost,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { AllExceptionsFilter } from './http-exception.filter';

// The error envelope every client reads: {success, statusCode, message,
// code} — plus whatever a thrower attached next to code/message (the DNS
// records a failed domain verify observed, for instance).

function run(exception: unknown) {
  const json = jest.fn<void, [Record<string, unknown>]>();
  const status = jest.fn(() => ({ json }));
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ headersSent: false, status }),
    }),
  } as unknown as ArgumentsHost;
  new AllExceptionsFilter().catch(exception, host);
  return { status, body: json.mock.calls[0][0] };
}

describe('AllExceptionsFilter', () => {
  it('keeps code and message, and forwards extra keys such as observed', () => {
    const { status, body } = run(
      new BadRequestException({
        code: 'MARKET_DOMAIN_VERIFY_FAILED',
        message: 'namez.se does not point at stores.platform.test yet.',
        observed: ['198.51.100.7'],
      }),
    );
    expect(status).toHaveBeenCalledWith(400);
    expect(body).toMatchObject({
      success: false,
      statusCode: 400,
      code: 'MARKET_DOMAIN_VERIFY_FAILED',
      message: 'namez.se does not point at stores.platform.test yet.',
      observed: ['198.51.100.7'],
    });
  });

  it('never lets an extra key override the envelope fields', () => {
    const { body } = run(
      new NotFoundException({
        code: 'X',
        message: 'm',
        success: true,
        statusCode: 200,
        timestamp: 'spoofed',
      }),
    );
    expect(body.success).toBe(false);
    expect(body.statusCode).toBe(404);
    expect(body.timestamp).not.toBe('spoofed');
  });

  it('plain-string Nest exceptions and unknown errors keep the legacy shape', () => {
    expect(run(new NotFoundException('gone')).body).toMatchObject({
      statusCode: 404,
      message: 'gone',
      code: undefined,
    });
    const spy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    expect(run(new Error('boom')).body).toMatchObject({
      statusCode: 500,
      message: 'Internal server error',
    });
    spy.mockRestore();
  });
});
