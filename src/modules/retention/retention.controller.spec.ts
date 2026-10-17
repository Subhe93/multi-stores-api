import { RetentionController } from './retention.controller';
import {
  RetentionService,
  UnknownRetentionTaskError,
} from './retention.service';

// M5 A16: the `task` query parameter is echoed in the error body, so it is
// capped and restricted to a slug before anything is run or echoed.

function build(run: jest.Mock = jest.fn()) {
  const service = { run, taskKeys: () => ['customer-uploads'] };
  return {
    controller: new RetentionController(service as unknown as RetentionService),
    run,
  };
}

async function errorBody(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return (e as { getResponse(): Record<string, unknown> }).getResponse();
  }
  return null;
}

describe('RetentionController (M5 A16)', () => {
  it('runs a valid task key', async () => {
    const { controller, run } = build(
      jest.fn(() => Promise.resolve({ acquired: true, results: {} })),
    );
    await controller.run('1', 'customer-uploads', undefined);
    expect(run).toHaveBeenCalledWith(expect.any(Date), {
      dryRun: true,
      task: 'customer-uploads',
      limit: undefined,
    });
  });

  it('refuses an over-long or non-slug task before running, echoing a capped, escaped copy', async () => {
    const { controller, run } = build();
    const evil = '<script>' + 'x'.repeat(200);
    const body = await errorBody(controller.run(undefined, evil, undefined));
    expect(run).not.toHaveBeenCalled();
    expect(body).toMatchObject({ code: 'RETENTION_TASK_UNKNOWN' });
    const echoed = (body as { params: { task: string } }).params.task;
    expect(echoed.length).toBeLessThanOrEqual(64);
    expect(echoed).not.toContain('<');
    expect((body as { message: string }).message).not.toContain('<');
  });

  it('an unknown (but well-formed) task is 400 RETENTION_TASK_UNKNOWN without echoing the service message', async () => {
    const { controller } = build(
      jest.fn(() => Promise.reject(new UnknownRetentionTaskError('nope'))),
    );
    const body = await errorBody(controller.run(undefined, 'nope', undefined));
    expect(body).toEqual({
      code: 'RETENTION_TASK_UNKNOWN',
      message: 'Unknown retention task',
      params: { task: 'nope' },
    });
  });
});
