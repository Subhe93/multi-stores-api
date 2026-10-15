import type {
  ViesHttpClient,
  ViesHttpResponse,
  ViesRequestBody,
} from './vies.types';

// VIES_MODE=mock transport: answers like the EC REST service without any
// network. It honours the official test-service numbers, so the same
// numbers behave identically against `/check-vat-test-service`:
//   100 valid ("John Doe"), 200 invalid, 201 INVALID_INPUT,
//   300 SERVICE_UNAVAILABLE, 301 MS_UNAVAILABLE, 302 TIMEOUT,
//   500 GLOBAL_MAX_CONCURRENT_REQ, 600 MS_MAX_CONCURRENT_REQ.
// Every other number: ending in 0000 is invalid, 9999 MS_UNAVAILABLE,
// 8888 TIMEOUT, anything else valid ("Mock Company <cc>").

const TEST_ERRORS: Record<string, string> = {
  '201': 'INVALID_INPUT',
  '300': 'SERVICE_UNAVAILABLE',
  '301': 'MS_UNAVAILABLE',
  '302': 'TIMEOUT',
  '500': 'GLOBAL_MAX_CONCURRENT_REQ',
  '600': 'MS_MAX_CONCURRENT_REQ',
};

function errorEnvelope(code: string): ViesHttpResponse {
  return {
    status: 200,
    json: { actionSucceed: false, errorWrappers: [{ error: code }] },
  };
}

export class MockViesHttpClient implements ViesHttpClient {
  post(_url: string, body: unknown): Promise<ViesHttpResponse> {
    const b = (body ?? {}) as Partial<ViesRequestBody>;
    const cc = String(b.countryCode ?? '');
    const number = String(b.vatNumber ?? '');
    const withRequester = !!b.requesterNumber;
    const answer = (valid: boolean, name: string | null): ViesHttpResponse => ({
      status: 200,
      json: {
        countryCode: cc,
        vatNumber: number,
        requestDate: new Date().toISOString(),
        valid,
        requestIdentifier: withRequester ? `MOCK-${cc}${number}` : '',
        name: name ?? '---',
        address: valid ? `Mock street 1, ${cc}` : '---',
      },
    });
    let res: ViesHttpResponse;
    if (TEST_ERRORS[number]) res = errorEnvelope(TEST_ERRORS[number]);
    else if (number === '100') res = answer(true, 'John Doe');
    else if (number === '200') res = answer(false, null);
    else if (number.endsWith('0000')) res = answer(false, null);
    else if (number.endsWith('9999')) res = errorEnvelope('MS_UNAVAILABLE');
    else if (number.endsWith('8888')) res = errorEnvelope('TIMEOUT');
    else res = answer(true, `Mock Company ${cc}`);
    return Promise.resolve(res);
  }
}
