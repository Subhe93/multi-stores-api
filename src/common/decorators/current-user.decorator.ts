import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { UserRole, UserStatus } from '@prisma/client';

/** The user JwtStrategy.validate() attaches to the request. */
export interface RequestUser {
  id: string;
  email: string;
  role: UserRole;
  status: UserStatus;
}

export const CurrentUser = createParamDecorator(
  (data: string | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<{ user?: RequestUser }>();
    const user = request.user;
    return data ? (user as Record<string, unknown> | undefined)?.[data] : user;
  },
);
