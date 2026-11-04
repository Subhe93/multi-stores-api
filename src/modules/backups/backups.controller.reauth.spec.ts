import { ForbiddenException } from '@nestjs/common';
import { UserRole, UserStatus } from '@prisma/client';
import type { Request } from 'express';
import { BackupsController } from './backups.controller';
import type { BackupsService } from './backups.service';
import type { ReauthService } from '../security/reauth.service';
import type { SecurityAuditService } from '../security/security-audit.service';
import type { RequestUser } from '../../common/decorators';

// Download, restore and delete of database backups need an admin re-auth
// grant (X-Reauth-Token) and leave a SecurityEvent.

const admin: RequestUser = {
  id: 'a1',
  email: 'admin@x.se',
  role: UserRole.ADMIN,
  status: UserStatus.ACTIVE,
  storeId: null,
};
const meta = { ip: '1.2.3.4', userAgent: 'jest' };

function build(grantOk = true) {
  const backups = {
    download: jest.fn(() => Promise.resolve('stream')),
    delete: jest.fn(() => Promise.resolve({ deleted: true })),
    restore: jest.fn(() => Promise.resolve({ restored: true })),
    create: jest.fn(() => Promise.resolve({ id: 'b9' })),
  };
  const reauth = {
    verifyGrant: jest.fn((_id: string, token: string) =>
      grantOk && token === 'grant'
        ? Promise.resolve({})
        : Promise.reject(new ForbiddenException({ code: 'REAUTH_REQUIRED' })),
    ),
  };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const controller = new BackupsController(
    backups as unknown as BackupsService,
    reauth as unknown as ReauthService,
    audit as unknown as SecurityAuditService,
  );
  return { controller, backups, reauth, audit };
}

const req = { socket: { setTimeout: jest.fn() } } as unknown as Request;
const actions = (audit: { record: jest.Mock }) =>
  audit.record.mock.calls.map(
    (c: unknown[]) => (c[0] as { action: string }).action,
  );

describe('BackupsController re-auth', () => {
  it('refuses download, delete and restore without a grant', async () => {
    const { controller, backups, audit } = build();
    await expect(
      controller.download(admin, 'b1', { file: 'db' }, undefined, meta),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      controller.remove(admin, 'b1', 'wrong', meta),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      controller.restore(
        admin,
        'b1',
        { confirm: 'RESTORE' },
        undefined,
        meta,
        req,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(backups.download).not.toHaveBeenCalled();
    expect(backups.delete).not.toHaveBeenCalled();
    expect(backups.restore).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('runs with a valid grant and records each action', async () => {
    const { controller, backups, audit } = build();
    await controller.download(admin, 'b1', { file: 'db' }, 'grant', meta);
    await controller.remove(admin, 'b1', 'grant', meta);
    await controller.restore(
      admin,
      'b1',
      { confirm: 'RESTORE' },
      'grant',
      meta,
      req,
    );
    expect(backups.download).toHaveBeenCalledWith('b1', 'db');
    expect(backups.delete).toHaveBeenCalledWith('b1');
    expect(backups.restore).toHaveBeenCalledWith(
      'b1',
      { confirm: 'RESTORE' },
      'a1',
    );
    expect(actions(audit)).toEqual([
      'backup.downloaded',
      'backup.deleted',
      'backup.restored',
      'backup.restored',
    ]);
  });

  it('records a manual backup without needing a grant', async () => {
    const { controller, audit, reauth } = build();
    await controller.create(admin, {}, meta);
    expect(reauth.verifyGrant).not.toHaveBeenCalled();
    expect(actions(audit)).toEqual(['backup.created']);
  });
});
