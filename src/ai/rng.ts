/** 可复现的确定性随机数工具（mulberry32） */

export interface RNG {
  next(): number; // [0,1)
  int(n: number): number; // [0, n)
  pick<T>(arr: readonly T[]): T;
}

export function mulberry32(seed: number): RNG {
  let a = seed >>> 0;
  const next = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n) => Math.floor(next() * n),
    pick: <T,>(arr: readonly T[]): T => arr[Math.floor(next() * arr.length)],
  };
}

/** 从 URL 读取 seed（?debug=1&seed=12345），否则用随机种子 */
export function makeSeed(): number {
  try {
    const params = new URLSearchParams(window.location.search);
    const s = params.get('seed');
    if (s !== null && s !== '' && !Number.isNaN(Number(s))) return Number(s) >>> 0;
  } catch {
    /* 非浏览器环境 */
  }
  return (Math.random() * 0xffffffff) >>> 0;
}

/** 从给定种子创建 rng；未给 seed 时使用安全随机种子 */
export function makeRng(seed?: number): RNG {
  return mulberry32(seed ?? ((Math.random() * 0xffffffff) >>> 0));
}
