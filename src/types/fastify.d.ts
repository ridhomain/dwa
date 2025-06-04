import 'fastify';
import Redis from 'ioredis';
import { JetStreamClient, JetStreamManager, NatsConnection } from 'nats';
import { Metrics } from '../../types/metrics';
import { TaskApiService } from '../services/api/taskApiService';
import { DbApiService } from '../services/api/dbApiService';
import { OnboardingService } from '../services/onboardingService';
import { ConfigLoaderService, LoadedConfigs } from '../services/configLoader';

declare module 'fastify' {
  interface FastifyInstance {
    redis: Redis;
    js: JetStreamClient;
    jsm: JetStreamManager;
    nats: NatsConnection;
    publishEvent: any;
    metrics: Metrics;
    taskApiService: TaskApiService;
    dbApiService: DbApiService;
    configLoader: ConfigLoaderService;
    mediaService: MediaDownloadService;
    onboardingService: OnboardingService;
    getConfig: <K extends keyof LoadedConfigs>(key: K) => LoadedConfigs[K];
    getConfigs: () => LoadedConfigs;
    reloadConfigs: () => Promise<LoadedConfigs>;
    config: {
      PORT: number;
      NODE_ENV: string;
      COMPANY_ID: string;
      AGENT_ID: string;
      REDIS_HOST: string;
      REDIS_PASSWORD: string;
      REDIS_PORT: number;
      NATS_SERVERS: string;
      NATS_USERNAME: string;
      NATS_PASSWORD: string;
      API_DB: string;
      TAGS: string;
      DB_API_URL: string;
      TASK_API_URL: string;
      TOKEN: string;
    };
  }
}
