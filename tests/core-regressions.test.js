import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  applyAdjustments,
  DIFFUSION_KERNELS,
  errorDiffusion,
  orderedDither,
  whiteNoiseDither,
} from '../js/engine/cpu.js';
import { GifEncoder } from '../js/export/gif.js';
import { Mp4Muxer } from '../js/export/mp4.js';
import { exportGIF, GIF_RETAINED_PIXEL_BUDGET, gifFrameBudget } from '../js/export/exporters.js';
import { LIVE_CPU_DITHER_BUDGETS, liveCpuDitherBudget } from '../js/preview-policy.js';
import { countGifFrames } from '../js/sources.js';

const GOLDEN_PALETTE = new Float32Array([
  0, 0, 0,
  255, 255, 255,
  255, 0, 64,
  0, 180, 255,
  240, 180, 0,
]);

const ERROR_DIFFUSION_GOLDENS = {
  floyd: {
    false: '5119164b898338b90dff9cc7f50a446288ddca2eb666e46dc6786306308eba85',
    true: 'efe8e527f789250679c106149b097b2f72df2b6423d9a05c1ee7bb9c4d50754d',
  },
  falsefloyd: {
    false: '44330d24602c8d4603de13eea5f3a59c9b966643d6fb2e6a85b98750d8506d8c',
    true: '2d3232e94450ae239d7ec412a17790c965104191de75164811e779df85edf70f',
  },
  jarvis: {
    false: '1a1f8611be3b1c4eb41cdfc18b1bf0d076504e7a3bd90bafc95dc461e4c0166c',
    true: '4ebf980af7741e222eb7d4b87d8e0d348e2c6fd2c1819b9a7777537313d3483d',
  },
  stucki: {
    false: 'e288822f76225018fbb9ce3f2931a5cc7d81d86efb100ca73f7f6e8dd5b80932',
    true: '68562502a0b198b9668ee9584166ec4f085e09f42339413c0e47354773da5eb4',
  },
  atkinson: {
    false: 'a90a55728bd818eca6444a94c3e50036c409369b3652a02b7cdd2bf8701c8304',
    true: '95cc48c9e59dc2e5d09df286b421662ee7eaefec346860c292c24928b26d9a9e',
  },
  burkes: {
    false: '2d82345ea647e6f92809279c6ff426a727d5e7725f0b24ed5db87b1c86e83dde',
    true: '5549da0682df3bd4abcf69bf05cc119cfca808bc16d94b52507749f5fd5ab586',
  },
  sierra3: {
    false: 'd6fc66fb9062cbdf37fdc19e22b805b84fed2d56693f46fd2e73d93ff204e728',
    true: '29580b1b6cf72c2bf6469678fef2d79de6254e7cd76dddb5b6d5f9b755df5c73',
  },
  sierra2: {
    false: '4a4c80715f9f59745ba34b5915cf23f0a9b66ec60608901802a85f63da395d6b',
    true: 'dbd11c7f6cd454e3805afdf8b2d5a11d21266746eb0e16889fc33c0dc01c4bca',
  },
  sierralite: {
    false: '2e2d5c555be7bb19a4966bdf204c4b98ff1442c95704acc036d5e6cf864078e0',
    true: '94de179de8aec50b41f2ee39f1f41aa8cf95efe7a8921c6de0c50ad499c26ac7',
  },
};

function goldenSource() {
  const width = 16;
  const height = 12;
  const data = new Uint8ClampedArray(width * height * 4);
  let state = 0x12345678;
  for (let pixel = 0; pixel < width * height; pixel++) {
    const offset = pixel * 4;
    for (let channel = 0; channel < 3; channel++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      data[offset + channel] = state >>> 24;
    }
    data[offset + 3] = pixel % 7 === 0 ? 128 : 255;
  }
  return { data, width, height };
}

for (const kernelId of Object.keys(ERROR_DIFFUSION_GOLDENS)) {
  for (const serpentine of [false, true]) {
    test(`errorDiffusion preserves ${kernelId} output (serpentine=${serpentine})`, () => {
      const image = goldenSource();
      errorDiffusion(image, GOLDEN_PALETTE, kernelId, {
        strength: 0.83,
        bias: 0.07,
        serpentine,
      });
      const digest = createHash('sha256').update(image.data).digest('hex');
      assert.equal(digest, ERROR_DIFFUSION_GOLDENS[kernelId][serpentine]);
    });
  }
}

test('errorDiffusion goldens cover every registered kernel', () => {
  assert.deepEqual(
    Object.keys(ERROR_DIFFUSION_GOLDENS).sort(),
    Object.keys(DIFFUSION_KERNELS).sort(),
  );
});

test('applyAdjustments identity preserves every RGBA byte', () => {
  const image = goldenSource();
  const before = image.data.slice();
  applyAdjustments(image, {
    brightness: 0,
    contrast: 0,
    gamma: 1,
    saturation: 1,
    invert: false,
  });
  assert.deepEqual(image.data, before);
});

test('1080p fine CPU dither settings keep distinct live work grids', () => {
  const fit = (pixelSize) => {
    let width = Math.round(1920 / pixelSize);
    let height = Math.round(1080 / pixelSize);
    const budget = liveCpuDitherBudget(pixelSize);
    if (width * height > budget) {
      const scale = Math.sqrt(budget / (width * height));
      width = Math.max(1, Math.floor(width * scale));
      height = Math.max(1, Math.floor(height * scale));
    }
    return [width, height];
  };
  assert.deepEqual(LIVE_CPU_DITHER_BUDGETS, {
    fine: 640_000,
    balanced: 420_000,
    coarse: 200_000,
  });
  assert.deepEqual(fit(1), [1066, 600]);
  assert.deepEqual(fit(2), [864, 486]);
  assert.deepEqual(fit(3), [596, 335]);
});

const BW_PALETTE = new Float32Array([0, 0, 0, 255, 255, 255]);
const QUARTER_THRESHOLD = { size: 1, data: new Float32Array([0.25]) };

function firstWhitePixel(dither, { strength, bias }) {
  for (let value = 0; value <= 255; value++) {
    const image = {
      width: 1,
      height: 1,
      data: new Uint8ClampedArray([value, value, value, 173]),
    };
    dither(image, strength, bias);
    assert.equal(image.data[3], 173, 'dithering must preserve alpha');
    if (image.data[0] === 255) return value;
  }
  return Infinity;
}

function orderedThreshold(strength, bias) {
  return firstWhitePixel(
    (image, s, b) => orderedDither(image, BW_PALETTE, QUARTER_THRESHOLD, {
      strength: s,
      bias: b,
    }),
    { strength, bias },
  );
}

function whiteNoiseThreshold(strength, bias) {
  // hash12(0, 0) is deterministic, so this measures the quantization boundary
  // without depending on a statistical assertion.
  return firstWhitePixel(
    (image, s, b) => whiteNoiseDither(image, BW_PALETTE, {
      strength: s,
      bias: b,
      seed: 0,
      ox: 0,
      oy: 0,
    }),
    { strength, bias },
  );
}

function assertBiasIsIndependentOfSpread(threshold, label) {
  for (const strength of [0, 0.1, 0.25]) {
    const unbiased = threshold(strength, 0);
    const biased = threshold(strength, 0.1);
    const shift = unbiased - biased;
    assert.ok(
      Math.abs(shift - 25.5) <= 0.5,
      `${label} strength=${strength} shifted by ${shift} levels; expected 25-26`,
    );
  }
}

test('orderedDither bias remains effective when strength is zero', () => {
  assert.ok(orderedThreshold(0, 0.1) < orderedThreshold(0, 0));
});

test('orderedDither bias is independent of dither spread', () => {
  assertBiasIsIndependentOfSpread(orderedThreshold, 'orderedDither');
});

test('whiteNoiseDither bias remains effective when strength is zero', () => {
  assert.ok(whiteNoiseThreshold(0, 0.1) < whiteNoiseThreshold(0, 0));
});

test('whiteNoiseDither bias is independent of dither spread', () => {
  assertBiasIsIndependentOfSpread(whiteNoiseThreshold, 'whiteNoiseDither');
});

function readU16LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32BE(bytes, offset) {
  return (
    bytes[offset] * 0x1000000
    + (bytes[offset + 1] << 16)
    + (bytes[offset + 2] << 8)
    + bytes[offset + 3]
  );
}

function ascii(bytes, start, length) {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function decodeGifLzw(payload, minimumCodeSize) {
  const clearCode = 1 << minimumCodeSize;
  const endCode = clearCode + 1;
  let codeSize;
  let nextCode;
  let dictionary;
  let previous = null;
  let bitOffset = 0;
  const output = [];

  const reset = () => {
    dictionary = Array.from({ length: clearCode }, (_, value) => [value]);
    dictionary[clearCode] = null;
    dictionary[endCode] = null;
    codeSize = minimumCodeSize + 1;
    nextCode = endCode + 1;
    previous = null;
  };
  const readCode = () => {
    let code = 0;
    for (let bit = 0; bit < codeSize; bit++) {
      const sourceBit = bitOffset + bit;
      if (payload[sourceBit >> 3] & (1 << (sourceBit & 7))) code |= 1 << bit;
    }
    bitOffset += codeSize;
    return code;
  };

  reset();
  while (bitOffset + codeSize <= payload.length * 8) {
    const code = readCode();
    if (code === clearCode) {
      reset();
      continue;
    }
    if (code === endCode) return output;

    let entry = dictionary[code];
    if (!entry && code === nextCode && previous) entry = [...previous, previous[0]];
    assert.ok(entry, `invalid GIF LZW code ${code}`);
    output.push(...entry);

    if (previous) {
      dictionary[nextCode++] = [...previous, entry[0]];
      if (nextCode === (1 << codeSize) && codeSize < 12) codeSize++;
    }
    previous = entry;
  }
  assert.fail('GIF LZW stream ended without an end-of-information code');
}

function inspectGif(bytes) {
  assert.equal(ascii(bytes, 0, 6), 'GIF89a');
  const width = readU16LE(bytes, 6);
  const height = readU16LE(bytes, 8);
  const packed = bytes[10];
  assert.ok(packed & 0x80, 'GIF must carry a global color table');
  const globalTableSize = 1 << ((packed & 0x07) + 1);
  let offset = 13 + globalTableSize * 3;
  let trailerSeen = false;
  const frames = [];

  const readSubBlocks = () => {
    const parts = [];
    let total = 0;
    while (true) {
      assert.ok(offset < bytes.length, 'GIF sub-block extends beyond file');
      const size = bytes[offset++];
      if (size === 0) break;
      assert.ok(offset + size <= bytes.length, 'GIF sub-block is truncated');
      parts.push(bytes.subarray(offset, offset + size));
      total += size;
      offset += size;
    }
    const joined = new Uint8Array(total);
    let cursor = 0;
    for (const part of parts) {
      joined.set(part, cursor);
      cursor += part.length;
    }
    return joined;
  };

  while (offset < bytes.length) {
    const marker = bytes[offset++];
    if (marker === 0x3b) {
      trailerSeen = true;
      break;
    }
    if (marker === 0x21) {
      assert.ok(offset < bytes.length, 'GIF extension has no label');
      offset++; // extension label
      readSubBlocks();
      continue;
    }
    assert.equal(marker, 0x2c, `unexpected GIF block marker 0x${marker.toString(16)}`);
    assert.ok(offset + 9 <= bytes.length, 'GIF image descriptor is truncated');
    const frameWidth = readU16LE(bytes, offset + 4);
    const frameHeight = readU16LE(bytes, offset + 6);
    const imagePacked = bytes[offset + 8];
    offset += 9;
    if (imagePacked & 0x80) offset += 3 * (1 << ((imagePacked & 0x07) + 1));
    const minimumCodeSize = bytes[offset++];
    const compressed = readSubBlocks();
    const indices = decodeGifLzw(compressed, minimumCodeSize);
    assert.equal(indices.length, frameWidth * frameHeight);
    assert.ok(indices.every((index) => index < globalTableSize));
    frames.push({ width: frameWidth, height: frameHeight, indices });
  }

  assert.ok(trailerSeen, 'GIF trailer is missing');
  assert.equal(offset, bytes.length, 'GIF contains bytes after its trailer');
  return { width, height, globalTableSize, frames };
}

function rgbaFromColors(width, height, colorAt) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const [r, g, b, a = 255] = colorAt(i);
    rgba.set([r, g, b, a], i * 4);
  }
  return rgba;
}

test('GIF frame budget remains bounded at native 4K and oversized dimensions', () => {
  assert.equal(gifFrameBudget(3840, 2160), 7);
  assert.equal(gifFrameBudget(8000, 8000), 1);
  assert.ok(gifFrameBudget(3840, 2160) * 3840 * 2160 <= GIF_RETAINED_PIXEL_BUDGET);
});

test('Static GIF export orchestration returns and downloads a decodable frame', async () => {
  const width = 16;
  const height = 8;
  const colors = [
    [10, 10, 10, 255],
    [245, 245, 245, 255],
    [248, 0, 64, 255],
    [0, 176, 248, 255],
  ];
  const pixels = rgbaFromColors(width, height, (i) => colors[i % colors.length]);
  const canvas = {
    width,
    height,
    getContext: () => ({
      getImageData: (_x, _y, w, h) => {
        assert.equal(w, width);
        assert.equal(h, height);
        return { data: pixels.slice() };
      },
    }),
  };
  const oldDocument = globalThis.document;
  let downloaded = null;
  globalThis.document = {
    createElement: (tag) => {
      assert.equal(tag, 'a');
      return {
        href: '',
        download: '',
        click() { downloaded = this.download; },
      };
    },
  };
  try {
    const blob = await exportGIF({
      video: null,
      renderFrame: () => canvas,
      maxWidth: width,
      name: 'fixture',
    });
    assert.equal(downloaded, 'fixture.gif');
    assert.equal(blob.type, 'image/gif');
    const gif = inspectGif(new Uint8Array(await blob.arrayBuffer()));
    assert.equal(gif.width, width);
    assert.equal(gif.height, height);
    assert.equal(gif.frames.length, 1);
  } finally {
    if (oldDocument === undefined) delete globalThis.document;
    else globalThis.document = oldDocument;
  }
});

test('GifEncoder uses byte-sized common frames and emits a decodable GIF89a', async () => {
  const width = 16;
  const height = 8;
  const encoder = new GifEncoder(width, height, { fps: 12, loop: true });
  const colors = [
    [0, 0, 0],
    [255, 255, 255],
    [248, 0, 64],
    [0, 176, 248],
  ];
  encoder.addFrame(rgbaFromColors(width, height, (i) => colors[i % colors.length]));
  encoder.addFrame(rgbaFromColors(width, height, (i) => colors[(i + 1) % colors.length]));

  assert.ok(encoder.frames[0] instanceof Uint8Array, 'a <=256-color frame should use one byte per pixel');
  assert.ok(encoder.frames[1] instanceof Uint8Array, 'all common frames should stay byte-sized');

  const blob = await encoder.finish();
  assert.equal(blob.type, 'image/gif');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const gif = inspectGif(bytes);
  assert.equal(gif.width, width);
  assert.equal(gif.height, height);
  assert.equal(gif.frames.length, 2);
});

test('GifEncoder keeps the >256-bucket path valid', async () => {
  const width = 257;
  const height = 1;
  const encoder = new GifEncoder(width, height, { fps: 15, loop: false });
  encoder.addFrame(rgbaFromColors(width, height, (i) => [
    ((i >> 10) & 31) << 3,
    ((i >> 5) & 31) << 3,
    (i & 31) << 3,
  ]));
  assert.ok(encoder.buckets.size > 256, 'fixture must exercise palette reduction');
  assert.equal(encoder.frames[0][256], 256, 'overflow bucket indices must not wrap at 255');

  const blob = await encoder.finish();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const gif = inspectGif(bytes);
  assert.equal(gif.globalTableSize, 256);
  assert.equal(gif.frames.length, 1);
  assert.equal(gif.frames[0].indices.length, width * height);
});

test('GIF frame scanner distinguishes static and animated files', async () => {
  const one = new GifEncoder(2, 2, { fps: 10 });
  one.addFrame(new Uint8ClampedArray([
    0, 0, 0, 255, 255, 255, 255, 255,
    255, 0, 0, 255, 0, 0, 255, 255,
  ]));
  const oneBytes = new Uint8Array(await (await one.finish()).arrayBuffer());
  assert.equal(countGifFrames(oneBytes), 1);

  const two = new GifEncoder(2, 2, { fps: 10 });
  two.addFrame(new Uint8ClampedArray([
    0, 0, 0, 255, 255, 255, 255, 255,
    255, 0, 0, 255, 0, 0, 255, 255,
  ]));
  two.addFrame(new Uint8ClampedArray([
    255, 255, 255, 255, 0, 0, 0, 255,
    0, 0, 255, 255, 255, 0, 0, 255,
  ]));
  const twoBytes = new Uint8Array(await (await two.finish()).arrayBuffer());
  assert.equal(countGifFrames(twoBytes), 2);
});

function parseTopLevelMp4Boxes(bytes) {
  const boxes = [];
  let offset = 0;
  while (offset < bytes.length) {
    assert.ok(offset + 8 <= bytes.length, 'MP4 box header is truncated');
    const size32 = readU32BE(bytes, offset);
    const type = ascii(bytes, offset + 4, 4);
    let size = size32;
    let headerSize = 8;
    if (size32 === 1) {
      assert.ok(offset + 16 <= bytes.length, 'large MP4 box header is truncated');
      const high = readU32BE(bytes, offset + 8);
      const low = readU32BE(bytes, offset + 12);
      size = high * 2 ** 32 + low;
      headerSize = 16;
    } else if (size32 === 0) {
      size = bytes.length - offset;
    }
    assert.ok(size >= headerSize, `${type} box has an invalid size`);
    assert.ok(offset + size <= bytes.length, `${type} box extends beyond the file`);
    boxes.push({ type, start: offset, dataStart: offset + headerSize, size });
    offset += size;
  }
  assert.equal(offset, bytes.length);
  return boxes;
}

function findAscii(bytes, value) {
  for (let i = 0; i <= bytes.length - value.length; i++) {
    if (ascii(bytes, i, value.length) === value) return i;
  }
  return -1;
}

function fakeEncodedChunk(data, type) {
  return {
    byteLength: data.length,
    type,
    copyTo(target) {
      target.set(data);
    },
  };
}

test('Mp4Muxer emits sane ftyp, 64-bit mdat, moov, and sample offsets', async () => {
  const muxer = new Mp4Muxer(320, 180, 30);
  const avcC = new Uint8Array([
    1, 0x42, 0, 0x1e, 0xff,
    0xe1, 0, 2, 0x67, 0,
    1, 0, 1, 0x68,
  ]);
  const keySample = new Uint8Array([0, 0, 0, 2, 0x65, 0x88]);
  const deltaSample = new Uint8Array([0, 0, 0, 2, 0x41, 0x9a]);
  muxer.addChunk(fakeEncodedChunk(keySample, 'key'), {
    decoderConfig: { description: avcC },
  });
  muxer.addChunk(fakeEncodedChunk(deltaSample, 'delta'));

  const blob = muxer.finalize();
  assert.equal(blob.type, 'video/mp4');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const boxes = parseTopLevelMp4Boxes(bytes);
  assert.deepEqual(boxes.map((entry) => entry.type), ['ftyp', 'mdat', 'moov']);
  assert.equal(ascii(bytes, boxes[0].dataStart, 4), 'isom');
  assert.ok(findAscii(bytes.subarray(boxes[0].dataStart, boxes[0].start + boxes[0].size), 'avc1') >= 0);

  const mdat = boxes[1];
  assert.equal(mdat.size, 16 + keySample.length + deltaSample.length);
  assert.deepEqual(
    bytes.subarray(mdat.dataStart, mdat.start + mdat.size),
    new Uint8Array([...keySample, ...deltaSample]),
  );

  for (const requiredBox of ['mvhd', 'trak', 'mdia', 'minf', 'stbl', 'stsd', 'stts', 'stss', 'stsc', 'stsz', 'stco', 'avcC']) {
    assert.ok(findAscii(bytes, requiredBox) >= 0, `${requiredBox} box is missing`);
  }
  const stcoTypeOffset = findAscii(bytes, 'stco');
  const stcoStart = stcoTypeOffset - 4;
  assert.equal(readU32BE(bytes, stcoStart + 12), 1, 'stco should contain one chunk');
  assert.equal(readU32BE(bytes, stcoStart + 16), mdat.dataStart, 'stco must point to the first sample');
});
