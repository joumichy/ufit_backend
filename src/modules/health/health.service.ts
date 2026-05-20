import { Inject, Injectable } from '@nestjs/common';
import { getEnv } from '../../config/env';
import { DatabaseService } from '../../shared/infrastructure/database/database.service';

export interface HealthResponse {
  status: 'ok' | 'degraded';
  service: 'ufit-backend';
  environment: string;
  database: {
    connected: boolean;
    schema: string;
    schemaExists: boolean;
    checkedAt: string;
  };
}

@Injectable()
export class HealthService {
  private readonly env = getEnv();

  constructor(@Inject(DatabaseService) private readonly databaseService: DatabaseService) {}

  async getHealth(): Promise<HealthResponse> {
    const database = await this.databaseService.checkHealth();

    return {
      status: database.connected && database.schemaExists ? 'ok' : 'degraded',
      service: 'ufit-backend',
      environment: this.env.NODE_ENV,
      database
    };
  }
}
