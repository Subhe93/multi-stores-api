import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

// `{code, message}` errors of the production app (M4.3 §3.7). Clients
// translate `errors.<code>`.

export const productionErrors = {
  /** Unknown order or another store's order (404, so ids are not enumerable). */
  orderNotFound: () =>
    new NotFoundException({
      code: 'PRODUCTION_ORDER_NOT_FOUND',
      message: 'Order not found.',
    }),
  checkNotFound: () =>
    new NotFoundException({
      code: 'PRODUCTION_CHECK_NOT_FOUND',
      message: 'Checklist item not found.',
    }),
  lineNotOwned: () =>
    new ForbiddenException({
      code: 'PRODUCTION_LINE_NOT_OWNED',
      message: 'This order line is fulfilled by someone else.',
    }),
  orderClosed: () =>
    new ConflictException({
      code: 'PRODUCTION_ORDER_CLOSED',
      message:
        'This order is cancelled, refunded or returned; its checklist is read-only.',
    }),
  customOnly: () =>
    new BadRequestException({
      code: 'PRODUCTION_CUSTOM_ONLY',
      message: 'Only items you added yourself can be removed.',
    }),
  labelInvalid: () =>
    new BadRequestException({
      code: 'PRODUCTION_LABEL_INVALID',
      message: 'The item text must be 1 to 80 characters.',
    }),
  tooManyChecks: (max: number) =>
    new BadRequestException({
      code: 'PRODUCTION_TOO_MANY_CHECKS',
      message: `An order line can have at most ${max} checklist items.`,
    }),
};
