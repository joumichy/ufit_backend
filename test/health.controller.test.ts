import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { HealthController } from '../src/modules/health/health.controller';
import { HealthService } from '../src/modules/health/health.service';

describe('HealthController', () => {
  it('returns the health response from the service', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: HealthService,
          useValue: {
            getHealth: () =>
              Promise.resolve({
                status: 'ok',
                service: 'ufit-backend',
                environment: 'test',
                database: {
                  connected: true,
                  schema: 'ufit',
                  schemaExists: true,
                  checkedAt: '2026-05-20T00:00:00.000Z'
                }
              })
          }
        }
      ]
    }).compile();

    const controller = moduleRef.get(HealthController);

    await expect(controller.getHealth()).resolves.toMatchObject({
      status: 'ok',
      service: 'ufit-backend',
      database: {
        schema: 'ufit',
        schemaExists: true
      }
    });
  });
});
