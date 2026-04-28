import { Redis } from "@upstash/redis";
import type { ToolMeta } from "./types";

export type Stored = {
  code: string;
  deps: Record<string, string>;
  mechanical: ToolMeta[];
  curated: ToolMeta[];
  createdAt: number;
};

const useRedis =
  !!process.env.UPSTASH_REDIS_REST_URL && !!process.env.UPSTASH_REDIS_REST_TOKEN;

const redis = useRedis
  ? new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    })
  : null;

const mem = new Map<string, Stored>();

const TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export const storage = {
  async get(id: string): Promise<Stored | null> {
    if (redis) return (await redis.get<Stored>(`code:${id}`)) ?? null;
    return mem.get(id) ?? null;
  },
  async set(id: string, value: Stored): Promise<void> {
    if (redis) {
      await redis.set(`code:${id}`, value, { ex: TTL_SECONDS });
    } else {
      mem.set(id, value);
    }
  },
};
