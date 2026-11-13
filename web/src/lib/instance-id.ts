import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

let cached: string | null = null;

/**
 * 服务器实例标识（plan v2 §3.1 壳↔站点契约）。
 *
 * 探活方（壳/发现器）用它把「同一台机器的多个 IP 入口」（有线 + WLAN 同网段
 * 是本项目的真实场景）合并为同一个 instance 的 endpoints，也能识别「同一地址
 * 换了另一台服务器」。
 *
 * 优先级：INSTANCE_ID 环境变量 > 项目根持久化文件 > 进程内随机（降级）。
 */
export function getInstanceId(): string {
  if (cached) return cached;
  const fromEnv = process.env.INSTANCE_ID?.trim();
  if (fromEnv) {
    cached = fromEnv;
    return cached;
  }
  const file = path.join(process.cwd(), '.libretv-instance-id');
  try {
    if (existsSync(file)) {
      const value = readFileSync(file, 'utf8').trim();
      if (value) {
        cached = value;
        return cached;
      }
    }
    const id = randomUUID();
    writeFileSync(file, `${id}\n`, 'utf8');
    cached = id;
    return cached;
  } catch {
    // 只读文件系统（部分容器部署）→ 进程级随机：重启后换 ID，
    // 探活方按「换了一台服务器」重新合并，可接受的降级
    cached = randomUUID();
    return cached;
  }
}
