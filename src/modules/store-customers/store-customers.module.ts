import { Module } from '@nestjs/common';
import { MagicLinkModule } from '../auth/magic-link.module';
import { AuthModule } from '../auth/auth.module';
import { StoreCustomersController } from './store-customers.controller';
import { AdminCustomersController } from './admin-customers.controller';
import { StoreCustomersService } from './store-customers.service';

// Customers of a store: the creator's Customers page (/stores/my/customers)
// and the admin's global list (/admin/customers). PrismaModule and
// MailModule are @Global.
@Module({
  imports: [MagicLinkModule, AuthModule],
  controllers: [StoreCustomersController, AdminCustomersController],
  providers: [StoreCustomersService],
})
export class StoreCustomersModule {}
