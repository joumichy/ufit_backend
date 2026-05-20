import { Controller, Get, Inject } from '@nestjs/common';
import { HealthService, type HealthResponse } from './health.service';

@Controller('health')
export class HealthController {
  constructor(@Inject(HealthService) private readonly healthService: HealthService) {}

  @Get()
  async getHealth(): Promise<HealthResponse> {
    return this.healthService.getHealth();
  }
}
