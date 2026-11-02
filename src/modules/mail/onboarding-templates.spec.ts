import {
  ONBOARDING_EVENTS,
  ONBOARDING_EVENT_VARIABLES,
  ONBOARDING_TEXT,
  onboardingEmail,
} from './onboarding-templates';
import { NotificationTemplatesService } from '../notification-templates/notification-templates.service';

// SPEC §5: every onboarding event has bundled wording in the six locales,
// values are escaped in the HTML, links land in the button, and nothing
// sensitive leaks into the subject.

const LOCALES = ['en', 'sv', 'ar', 'de', 'fr', 'tr'];

describe('onboarding email templates', () => {
  it('every event has every locale with a subject, title and body', () => {
    for (const event of ONBOARDING_EVENTS) {
      for (const locale of LOCALES) {
        const t = ONBOARDING_TEXT[event][locale];
        expect(t).toBeDefined();
        expect(t.subject.trim()).not.toBe('');
        expect(t.title.trim()).not.toBe('');
        expect(t.body.length).toBeGreaterThan(0);
      }
    }
  });

  it('every event is in the admin template catalog with its variables', () => {
    const catalog = NotificationTemplatesService.EVENT_CATALOG;
    for (const event of ONBOARDING_EVENTS) {
      const entry = catalog.find((e) => e.event === event);
      expect(entry).toBeDefined();
      expect(entry!.variables).toEqual(ONBOARDING_EVENT_VARIABLES[event]);
    }
  });

  it('email_verification: the link is in the button, escaped values, subject without the link', () => {
    const url = 'https://dash.example.com/auth/verify#token=raw-secret-123';
    const out = onboardingEmail(
      'email_verification',
      {
        platform_name: 'ShopsDoor',
        name: '<b>Anna</b>',
        verify_url: url,
        expires_hours: '24',
      },
      'en',
      { platformName: 'ShopsDoor' },
    );
    expect(out.subject).toBe('Verify your email for ShopsDoor');
    expect(out.subject).not.toContain('raw-secret');
    expect(out.html).toContain(`href="${url}"`);
    expect(out.html).toContain('&lt;b&gt;Anna&lt;/b&gt;');
    expect(out.html).not.toContain('<b>Anna</b>');
    expect(out.html).toContain('valid for 24 hours');
    expect(out.text).toContain(url);
    expect(out.text).toContain('ignore this email');
  });

  it('falls back to English for an unknown locale and renders Arabic RTL', () => {
    const vars = { platform_name: 'P', name: 'A', store_name: 'S', reason: 'r' };
    expect(onboardingEmail('store_suspended', vars, 'xx').subject).toBe(
      'S has been suspended',
    );
    const ar = onboardingEmail('store_suspended', vars, 'ar');
    expect(ar.html).toContain('dir="rtl"');
    expect(ar.subject).toContain('S');
  });

  it('store_changes_requested carries the reason; admin events the summary', () => {
    const changes = onboardingEmail(
      'store_changes_requested',
      { platform_name: 'P', name: 'A', store_name: 'S', reason: 'Add a logo', dashboard_url: 'https://d' },
      'sv',
    );
    expect(changes.html).toContain('Add a logo');
    expect(changes.html).toContain('href="https://d"');
    const admin = onboardingEmail(
      'admin_golive_request',
      {
        platform_name: 'P',
        store_name: 'S',
        store_slug: 's',
        owner_email: 'o@x.se',
        checklist: 'email_verified: yes',
        review_url: 'https://d/admin/stores',
      },
      'en',
    );
    expect(admin.subject).toBe('Go-live request: S');
    expect(admin.html).toContain('email_verified: yes');
    expect(admin.html).toContain('href="https://d/admin/stores"');
  });
});
