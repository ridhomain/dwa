import Redis from 'ioredis';

export interface IDeleteKeysOptions {
  redis: Redis;
  pattern: string;
}

export const deleteKeysWithPattern = async ({
  redis,
  pattern,
}: IDeleteKeysOptions): Promise<void> => {
  let cursor = '0';
  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = nextCursor;
    if (keys.length > 0) {
      await redis.unlink(...keys);
      console.log(`Deleted ${keys.length} keys matching "${pattern}"`);
    }
  } while (cursor !== '0');
};
