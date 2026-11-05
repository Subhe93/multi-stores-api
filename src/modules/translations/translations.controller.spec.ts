import { UserRole } from '@prisma/client';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { TranslationsController } from './translations.controller';

/** Role access of the translation routes: only translate-text is open to providers. */
describe('TranslationsController roles', () => {
  const proto = TranslationsController.prototype as unknown as Record<
    string,
    object
  >;
  const rolesOf = (name: string) =>
    (Reflect.getMetadata(ROLES_KEY, proto[name]) ??
      Reflect.getMetadata(ROLES_KEY, TranslationsController)) as UserRole[];

  it('the controller defaults to CREATOR and ADMIN', () => {
    expect(Reflect.getMetadata(ROLES_KEY, TranslationsController)).toEqual([
      UserRole.CREATOR,
      UserRole.ADMIN,
    ]);
  });

  it('translate-text also allows PROVIDER', () => {
    expect(rolesOf('translateText')).toEqual(
      expect.arrayContaining([
        UserRole.CREATOR,
        UserRole.ADMIN,
        UserRole.PROVIDER,
      ]),
    );
  });

  it.each(['getOverview', 'autoTranslate', 'bulkTranslate'])(
    '%s stays closed to providers',
    (name) => {
      expect(rolesOf(name)).not.toContain(UserRole.PROVIDER);
      expect(rolesOf(name)).toContain(UserRole.CREATOR);
    },
  );
});
