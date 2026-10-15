import type { ViesHttpClient, ViesHttpResponse } from './vies.types';

/**
 * Live transport: global fetch with AbortSignal.timeout (the same pattern
 * as the translations and Kustom clients). Network errors and aborts
 * propagate; ViesService maps them to UNAVAILABLE.
 */
export class FetchViesHttpClient implements ViesHttpClient {
  async post(
    url: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<ViesHttpResponse> {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, json };
  }
}
