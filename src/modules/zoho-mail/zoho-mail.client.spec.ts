import {
  ZOHO_REGIONS,
  ZOHO_SCOPES,
  accountIdFor,
  accountsHost,
  buildAuthorizeUrl,
  buildSendPayload,
  exchangeCode,
  fetchAccounts,
  formatFrom,
  isZohoRegion,
  mailHost,
  mapFromAddresses,
  parseAccounts,
  refreshAccessToken,
  regionFromAccountsServer,
  revokeToken,
  sendMessage,
  uploadAttachment,
  ZohoApiError,
} from './zoho-mail.client';

type FetchMock = jest.Mock<Promise<unknown>, [string, RequestInit]>;

function mockFetch(status: number, json: unknown): FetchMock {
  const fn = jest.fn(() =>
    Promise.resolve({ status, json: () => Promise.resolve(json) }),
  ) as unknown as FetchMock;
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

const headersOf = (init: RequestInit) => init.headers as Record<string, string>;

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
});

describe('zoho regions', () => {
  it('allowlist and host mapping', () => {
    expect(ZOHO_REGIONS).toEqual([
      'zoho.com',
      'zoho.eu',
      'zoho.in',
      'zoho.com.cn',
      'zoho.com.au',
      'zoho.jp',
      'zohocloud.ca',
      'zoho.sa',
    ]);
    expect(isZohoRegion('zoho.eu')).toBe(true);
    expect(isZohoRegion('evil.com')).toBe(false);
    expect(isZohoRegion('zoho.eu.evil.com')).toBe(false);
    expect(accountsHost('zoho.eu')).toBe('https://accounts.zoho.eu');
    expect(mailHost('zohocloud.ca')).toBe('https://mail.zohocloud.ca');
  });

  it('accepts only https://accounts.<allowed dc> as accounts-server', () => {
    expect(regionFromAccountsServer('https://accounts.zoho.eu')).toBe(
      'zoho.eu',
    );
    expect(regionFromAccountsServer('https://accounts.zoho.com.au/')).toBe(
      'zoho.com.au',
    );
    for (const bad of [
      'http://accounts.zoho.eu',
      'https://accounts.evil.com',
      'https://accounts.zoho.eu.evil.com',
      'https://accounts.zoho.eu:8443',
      'https://user@accounts.zoho.eu',
      'https://accounts.zoho.eu/x',
      'https://accounts.zoho.eu?x=1',
      'https://mail.zoho.eu',
      'accounts.zoho.eu',
      '',
      undefined,
    ]) {
      expect(regionFromAccountsServer(bad)).toBeNull();
    }
  });
});

describe('buildAuthorizeUrl', () => {
  it('carries the documented params and only the client id as credential', () => {
    const url = new URL(
      buildAuthorizeUrl({
        region: 'zoho.eu',
        clientId: 'cid',
        redirectUri: 'https://api.test/api/zoho-mail/oauth/callback',
        state: 'st.sig',
      }),
    );
    expect(url.origin + url.pathname).toBe(
      'https://accounts.zoho.eu/oauth/v2/auth',
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'cid',
      scope: ZOHO_SCOPES,
      redirect_uri: 'https://api.test/api/zoho-mail/oauth/callback',
      access_type: 'offline',
      prompt: 'consent',
      state: 'st.sig',
    });
  });
});

describe('token calls', () => {
  it('exchange posts a form body; no secret in the URL', async () => {
    const f = mockFetch(200, {
      access_token: 'at',
      refresh_token: 'rt',
      expires_in: 3600,
    });
    const t = await exchangeCode({
      region: 'zoho.com',
      clientId: 'cid',
      clientSecret: 'secret',
      redirectUri: 'https://r',
      code: 'the-code',
    });
    expect(t).toEqual({
      access_token: 'at',
      refresh_token: 'rt',
      expires_in: 3600,
    });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://accounts.zoho.com/oauth/v2/token');
    expect(init.method).toBe('POST');
    expect(headersOf(init)['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );
    expect(
      Object.fromEntries(new URLSearchParams(init.body as string)),
    ).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      client_id: 'cid',
      client_secret: 'secret',
      redirect_uri: 'https://r',
    });
  });

  it('a 200 with an error field fails without secrets in the message', async () => {
    mockFetch(200, { error: 'invalid_code' });
    const err = await exchangeCode({
      region: 'zoho.com',
      clientId: 'cid',
      clientSecret: 'secret',
      redirectUri: 'https://r',
      code: 'the-code',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ZohoApiError);
    expect((err as ZohoApiError).zohoCode).toBe('invalid_code');
    expect((err as Error).message).not.toMatch(/secret|the-code/);
  });

  it('refresh posts grant_type=refresh_token', async () => {
    const f = mockFetch(200, { access_token: 'at2', expires_in: 3600 });
    await refreshAccessToken({
      region: 'zoho.eu',
      clientId: 'cid',
      clientSecret: 's',
      refreshToken: 'rt',
    });
    const body = new URLSearchParams(f.mock.calls[0][1].body as string);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('rt');
    expect(f.mock.calls[0][0]).toBe('https://accounts.zoho.eu/oauth/v2/token');
  });

  it('revoke sends the token in the body', async () => {
    const f = mockFetch(200, {});
    await revokeToken({ region: 'zoho.in', token: 'rt' });
    expect(f.mock.calls[0][0]).toBe(
      'https://accounts.zoho.in/oauth/v2/token/revoke?token=rt',
    );
    expect(f.mock.calls[0][1].body).toBe('token=rt');
  });
});

describe('accounts mapping', () => {
  const body = {
    data: [
      {
        accountId: '111',
        primaryEmailAddress: 'owner@shop.se',
        sendMailDetails: [
          { fromAddress: 'owner@shop.se' },
          { fromAddress: 'info@shop.se' },
        ],
      },
      {
        accountId: 222,
        primaryEmailAddress: 'orders@shop.se',
        sendMailDetails: [
          { fromAddress: 'orders@shop.se' },
          { fromAddress: 'INFO@shop.se' },
          { fromAddress: 'not an address' },
        ],
      },
    ],
  };

  it('maps every from address to the account that owns it', () => {
    const list = mapFromAddresses(parseAccounts(body));
    expect(list).toEqual([
      { address: 'owner@shop.se', account_id: '111' },
      { address: 'info@shop.se', account_id: '111' },
      { address: 'orders@shop.se', account_id: '222' },
    ]);
    // Unlike the plugin (always data[0]), orders@ maps to its own account.
    expect(accountIdFor(list, 'Orders@Shop.se')).toBe('222');
    expect(accountIdFor(list, 'nobody@shop.se')).toBeNull();
  });

  it('fetchAccounts sends the Zoho-oauthtoken header', async () => {
    const f = mockFetch(200, body);
    const accounts = await fetchAccounts({
      region: 'zoho.eu',
      accessToken: 'at',
    });
    expect(accounts).toHaveLength(2);
    expect(f.mock.calls[0][0]).toBe('https://mail.zoho.eu/api/accounts');
    expect(headersOf(f.mock.calls[0][1]).Authorization).toBe(
      'Zoho-oauthtoken at',
    );
  });

  it('a 401 surfaces as ZohoApiError status 401', async () => {
    mockFetch(401, { data: { errorCode: 'INVALID_OAUTHTOKEN' } });
    const err = await fetchAccounts({
      region: 'zoho.eu',
      accessToken: 'x',
    }).catch((e: unknown) => e);
    expect((err as ZohoApiError).status).toBe(401);
    expect((err as Error).message).toContain('INVALID_OAUTHTOKEN');
  });
});

describe('send payload', () => {
  it('maps addresses, html and attachments; header-injection safe', () => {
    const p = buildSendPayload(
      {
        fromAddress: 'info@shop.se',
        fromName: 'Shop, AB\r\nBcc: evil@x.com',
        to: 'a@x.se, bad, b@x.se',
        cc: ['c@x.se'],
        bcc: 'd@x.se',
        replyTo: 'r@x.se',
        subject: 'Hello\r\nBcc: evil@x.com',
        html: '<p>h</p>',
        text: 't',
      },
      [{ storeName: 's', attachmentPath: '/p', attachmentName: 'f.pdf' }],
    );
    expect(p).toEqual({
      fromAddress: '"Shop, AB Bcc: evil@x.com" <info@shop.se>',
      toAddress: 'a@x.se,b@x.se',
      ccAddress: 'c@x.se',
      bccAddress: 'd@x.se',
      replyTo: 'r@x.se',
      subject: 'Hello Bcc: evil@x.com',
      content: '<p>h</p>',
      mailFormat: 'html',
      attachments: [
        { storeName: 's', attachmentPath: '/p', attachmentName: 'f.pdf' },
      ],
    });
  });

  it('plaintext without html; no optional keys when unset', () => {
    const p = buildSendPayload({
      fromAddress: 'info@shop.se',
      to: 'a@x.se',
      subject: 'S',
      text: 'plain',
    });
    expect(p).toEqual({
      fromAddress: 'info@shop.se',
      toAddress: 'a@x.se',
      subject: 'S',
      content: 'plain',
      mailFormat: 'plaintext',
    });
    expect(formatFrom('a@x.se', 'Acme')).toBe('Acme <a@x.se>');
  });

  it('refuses a message without a valid recipient', () => {
    expect(() =>
      buildSendPayload({ fromAddress: 'a@x.se', to: 'nope', subject: 's' }),
    ).toThrow(ZohoApiError);
  });

  it('upload posts raw bytes, then send posts JSON to the account', async () => {
    const f = mockFetch(200, {
      data: { storeName: 's', attachmentPath: '/p', attachmentName: 'f.pdf' },
    });
    const up = await uploadAttachment({
      region: 'zoho.eu',
      accessToken: 'at',
      accountId: '222',
      filename: '../Faktura 1.pdf',
      content: Buffer.from('pdf'),
    });
    expect(up).toEqual({
      storeName: 's',
      attachmentPath: '/p',
      attachmentName: 'f.pdf',
    });
    expect(f.mock.calls[0][0]).toBe(
      'https://mail.zoho.eu/api/accounts/222/messages/attachments?fileName=Faktura%201.pdf',
    );
    expect(headersOf(f.mock.calls[0][1])['Content-Type']).toBe(
      'application/octet-stream',
    );

    const g = mockFetch(200, { status: { code: 200 } });
    const payload = buildSendPayload({
      fromAddress: 'info@shop.se',
      to: 'a@x.se',
      subject: 'S',
      html: 'h',
    });
    await sendMessage({
      region: 'zoho.eu',
      accessToken: 'at',
      accountId: '222',
      payload,
    });
    expect(g.mock.calls[0][0]).toBe(
      'https://mail.zoho.eu/api/accounts/222/messages',
    );
    expect(JSON.parse(g.mock.calls[0][1].body as string)).toEqual(payload);
  });

  it('rejects attachments over 10 MB before uploading', async () => {
    const f = mockFetch(200, {});
    await expect(
      uploadAttachment({
        region: 'zoho.eu',
        accessToken: 'at',
        accountId: '1',
        filename: 'big.bin',
        content: Buffer.alloc(10 * 1024 * 1024 + 1),
      }),
    ).rejects.toThrow(/10 MB/);
    expect(f).not.toHaveBeenCalled();
  });
});
