import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { EditHintTokenService } from './edit-hint-token.service';

// Own JwtModule instance without a default secret: every sign/verify of the
// edit-hint token passes its derived secret explicitly, so this module can
// never fall back to the session JWT_SECRET.
@Module({
  imports: [JwtModule.register({})],
  providers: [EditHintTokenService],
  exports: [EditHintTokenService],
})
export class EditHintTokenModule {}
