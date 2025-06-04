import Redis from 'ioredis';
import {
  AuthenticationCreds,
  AuthenticationState,
  SignalDataTypeMap,
  SignalDataSet,
  initAuthCreds,
  BufferJSON,
  proto,
} from 'baileys';

export const createRedisAuthStore = async (
  redis: Redis,
  prefix: string
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> => {
  const readData = async (key: string) => {
    const data = await redis.get(`${prefix}:${key}`);
    return data ? JSON.parse(data, BufferJSON.reviver) : null;
  };

  const writeData = async (key: string, value: any) => {
    await redis.set(`${prefix}:${key}`, JSON.stringify(value, BufferJSON.replacer));
  };

  const creds: AuthenticationCreds = (await readData('creds')) ?? initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const results = await Promise.all(ids.map((id) => readData(`${type}-${id}`)));
          return ids.reduce(
            (acc, id, index) => {
              const val = results[index];
              if (val) {
                acc[id] =
                  type === 'app-state-sync-key'
                    ? proto.Message.AppStateSyncKeyData.fromObject(val)
                    : val;
              }
              return acc;
            },
            {} as { [_: string]: SignalDataTypeMap[typeof type] }
          );
        },
        set: async (data) => {
          const pipeline = redis.pipeline();
          for (const type of Object.keys(data) as Array<keyof SignalDataSet>) {
            for (const id in data[type]) {
              const key = `${prefix}:${type}-${id}`;
              const value = data[type][id];
              if (value) {
                pipeline.set(key, JSON.stringify(value, BufferJSON.replacer));
              } else {
                pipeline.del(key);
              }
            }
          }
          await pipeline.exec();
        },
      },
    },
    saveCreds: async () => writeData('creds', creds),
  };
};
