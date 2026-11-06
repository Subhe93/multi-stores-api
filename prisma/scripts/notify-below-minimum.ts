/**
 * One-off warning to creators whose PUBLISHED marketplace custom products
 * sell below the new minimum price (commit 74a1204: provider base + variant
 * adjustment, x (1 + highest destination VAT) when prices include VAT). The
 * products keep selling; each creator gets one in-app notification and one
 * email (their locale: dashboard UI locale when known, else the store's
 * primary locale, else en) listing title, current price, minimum price and
 * the product's edit link. Logic: notify-below-minimum.lib.ts.
 *
 * Modes:
 *   --dry-run (default)  counts + one line per creator (creator id, store
 *                        slug, product count); no names, emails or prices
 *   --send               notify + email every creator not warned yet
 *   --force              with --send: ignore the 30-day sent markers
 *   --delay-ms=<n>       pause between creators when sending (default 1000)
 *
 * Idempotent: the notification row (type PRICE_BELOW_MINIMUM, data.dedupe_key)
 * is the marker; a creator whose marker is younger than 30 days and whose
 * email went out is skipped. A marker whose email failed is retried by the
 * next --send without a second notification. Emails are recorded in the
 * delivery log (event price_below_minimum).
 *
 * Needs the API env (DATABASE_URL, ENCRYPTION_KEY[_WRAPPED] for the SMTP
 * password, DASHBOARD_URL). Never prints secrets or personal data; the Nest
 * loggers of the reused services are silenced for the same reason.
 *
 * Run with:  npx ts-node prisma/scripts/notify-below-minimum.ts
 *            npx ts-node prisma/scripts/notify-below-minimum.ts --send
 */
import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { CryptoService } from '../../src/common/crypto/crypto.service';
import { MailService } from '../../src/modules/mail/mail.service';
import { NotificationTemplatesService } from '../../src/modules/notification-templates/notification-templates.service';
import { TaxService } from '../../src/modules/taxes/tax.service';
import {
  collectBelowMinimum,
  parseArgs,
  type NotifyDb,
  runNotify,
} from './notify-below-minimum.lib';

const DEFAULT_DASHBOARD_URL = 'http://localhost:3002';

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  // The reused services log recipients and SMTP hosts; keep the output to
  // this script's own counts.
  Logger.overrideLogger(false);

  const client = new PrismaClient();
  const prisma = client as unknown as PrismaService;
  try {
    const taxService = new TaxService(prisma);
    const groups = await collectBelowMinimum(prisma, taxService);

    let mail: MailService | null = null;
    let platformName: string | undefined;
    if (opts.send) {
      const config = new ConfigService();
      const crypto = new CryptoService(config);
      await crypto.onModuleInit();
      mail = new MailService(
        config,
        prisma,
        crypto,
        new NotificationTemplatesService(prisma),
      );
      const cfg = await client.platformConfig.findFirst({
        select: { platform_name: true },
      });
      platformName = cfg?.platform_name?.trim() || undefined;
    }

    const summary = await runNotify(groups, opts, {
      db: client as unknown as NotifyDb,
      mail: mail ?? {
        send: () => Promise.reject(new Error('Dry run never sends')),
      },
      dashboardUrl: process.env.DASHBOARD_URL || DEFAULT_DASHBOARD_URL,
      platformName,
      log: (line) => console.log(line),
    });
    if (!opts.send) console.log('Dry run: nothing sent. Re-run with --send.');
    return summary.failed ? 1 : 0;
  } finally {
    await client.$disconnect();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // Messages only for the script's own errors (bad arguments); database
    // and driver errors print their class alone, as they can echo row data.
    const plain = err instanceof Error && err.constructor === Error;
    console.error(
      `notify-below-minimum failed: ${plain ? err.message : err instanceof Error ? err.name : 'Error'}`,
    );
    process.exit(1);
  });
