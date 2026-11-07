import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { ReauthDto } from '../../../security/dto/security.dto';

/** PUT /stores/my/payments/stripe-key (+ re-auth fields). */
export class SaveOwnKeyDto extends ReauthDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  publishable_key!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  restricted_key!: string;
}

/** DELETE /stores/my/payments/stripe-key (re-auth only). */
export class RemoveOwnKeyDto extends ReauthDto {}
