import { UserRole } from '@prisma/client';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { REQUIRE_APP_KEY } from '../../common/decorators/require-app.decorator';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { RequireAppGuard } from '../../common/guards/require-app.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ImporterCreatorController } from './importer-creator.controller';
import { ImporterAdminController } from './importer-admin.controller';

/** Authorization of the importer routes (M4.4 §10): CREATOR + JWT, every write @RequireApp('importer'). */
describe('importer controllers authorization', () => {
  const proto = ImporterCreatorController.prototype as unknown as Record<
    string,
    unknown
  >;
  const writes = [
    'createSource',
    'updateSource',
    'deleteSource',
    'verifySource',
    'createRun',
    'updateOptions',
    'confirm',
    'cancel',
    'rollback',
    'deleteRun',
  ];
  const reads = [
    'listSources',
    'listRuns',
    'getRun',
    'runItems',
    'runLogs',
    'runReport',
    'exportScript',
  ];

  it('the creator controller requires JWT, the CREATOR role and the app guard', () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      ImporterCreatorController,
    ) as unknown[];
    expect(guards).toEqual(
      expect.arrayContaining([RolesGuard, RequireAppGuard]),
    );
    expect(guards).toHaveLength(3);
    expect(Reflect.getMetadata(ROLES_KEY, ImporterCreatorController)).toEqual([
      UserRole.CREATOR,
    ]);
  });

  it.each(writes)('write %s carries @RequireApp("importer")', (name) => {
    expect(Reflect.getMetadata(REQUIRE_APP_KEY, proto[name] as object)).toBe(
      'importer',
    );
  });

  it.each(reads)('read %s stays open without the app', (name) => {
    expect(
      Reflect.getMetadata(REQUIRE_APP_KEY, proto[name] as object),
    ).toBeUndefined();
  });

  it('the directory-bundle route is ADMIN only and requires the app on the store', () => {
    expect(Reflect.getMetadata(ROLES_KEY, ImporterAdminController)).toEqual([
      UserRole.ADMIN,
    ]);
    const fn = (
      ImporterAdminController.prototype as unknown as Record<string, object>
    ).fromDirectory;
    expect(Reflect.getMetadata(REQUIRE_APP_KEY, fn)).toBe('importer');
  });
});
