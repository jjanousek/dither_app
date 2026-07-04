// Blue noise threshold texture via the void-and-cluster method (Ulichney).
// Generated once at startup (64x64 default) and cached; returns a
// Float32Array of thresholds in 0..1 plus the raw Uint8Array for texture upload.

function makeGaussianLUT(size, sigma) {
  // Toroidal squared-distance energy lookup, indexed by (dy*size+dx).
  const lut = new Float32Array(size * size);
  const s2 = 2 * sigma * sigma;
  for (let dy = 0; dy < size; dy++) {
    const wy = Math.min(dy, size - dy);
    for (let dx = 0; dx < size; dx++) {
      const wx = Math.min(dx, size - dx);
      lut[dy * size + dx] = Math.exp(-(wx * wx + wy * wy) / s2);
    }
  }
  return lut;
}

export function generateBlueNoise(size = 64, seed = 1234) {
  const n = size * size;
  const sigma = 1.9;
  const lut = makeGaussianLUT(size, sigma);
  const energy = new Float32Array(n);
  const binary = new Uint8Array(n);
  const rank = new Int32Array(n).fill(-1);

  // Deterministic PRNG (mulberry32) so the pattern is stable across runs.
  let s = seed >>> 0;
  const rand = () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const addEnergy = (idx, sign) => {
    const px = idx % size, py = (idx / size) | 0;
    for (let y = 0; y < size; y++) {
      const dy = (y - py + size) % size;
      const row = y * size;
      const lrow = dy * size;
      for (let x = 0; x < size; x++) {
        const dx = (x - px + size) % size;
        energy[row + x] += sign * lut[lrow + dx];
      }
    }
  };

  // 1) Random initial pattern with ~10% ones.
  const initial = Math.max(1, Math.floor(n * 0.1));
  let placed = 0;
  while (placed < initial) {
    const i = (rand() * n) | 0;
    if (!binary[i]) {
      binary[i] = 1;
      addEnergy(i, +1);
      placed++;
    }
  }

  const tightest = () => {
    let best = -1, bestE = -Infinity;
    for (let i = 0; i < n; i++) if (binary[i] && energy[i] > bestE) { bestE = energy[i]; best = i; }
    return best;
  };
  const largestVoid = () => {
    let best = -1, bestE = Infinity;
    for (let i = 0; i < n; i++) if (!binary[i] && energy[i] < bestE) { bestE = energy[i]; best = i; }
    return best;
  };

  // 2) Relax initial pattern: move tightest cluster to largest void until stable.
  for (let iter = 0; iter < n; iter++) {
    const c = tightest();
    binary[c] = 0; addEnergy(c, -1);
    const v = largestVoid();
    binary[v] = 1; addEnergy(v, +1);
    if (v === c) break;
  }

  // 3) Rank phase A: remove tightest clusters down to zero -> ranks initial-1..0
  const snapshot = binary.slice();
  const energySnap = energy.slice();
  let count = 0;
  for (let i = 0; i < n; i++) count += binary[i];
  let r = count - 1;
  while (r >= 0) {
    const c = tightest();
    binary[c] = 0; addEnergy(c, -1);
    rank[c] = r--;
  }

  // 4) Rank phase B: refill from snapshot, insert into largest void -> ranks count..n-1
  binary.set(snapshot);
  energy.set(energySnap);
  for (let rr = count; rr < n; rr++) {
    const v = largestVoid();
    binary[v] = 1; addEnergy(v, +1);
    rank[v] = rr;
  }

  const thresholds = new Float32Array(n);
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    thresholds[i] = (rank[i] + 0.5) / n;
    bytes[i] = Math.round((rank[i] / (n - 1)) * 255);
  }
  return { size, data: thresholds, bytes };
}

let cached = null;
export function getBlueNoise() {
  if (!cached) cached = generateBlueNoise(64);
  return cached;
}
