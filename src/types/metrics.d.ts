import { Registry, Counter, Gauge } from 'prom-client';

export interface Metrics {
  register: Registry;
  counters: {
    natsErrorCounter: Counter<string>;
    redisErrorCounter: Counter<string>;
  };
  gauges: {
    [key: string]: Gauge<string>;
  };
}
