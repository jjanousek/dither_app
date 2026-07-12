// Minimal MP4 (ISO base media) muxer for a single H.264 video track produced
// by WebCodecs VideoEncoder in "avc" (length-prefixed) format. Constant frame
// rate, video only — no audio. Samples are held as compressed chunks (a few
// MB for a clip), so memory stays flat regardless of resolution or length.
//
// Layout written: [ftyp][mdat: all samples][moov: sample tables]. The moov's
// chunk offset points back into the earlier mdat, which is legal.

const TIMESCALE = 90000;

function u32(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }
function u64(n) { return [...u32(Math.floor(n / 2 ** 32)), ...u32(n >>> 0)]; }
function u16(n) { return [(n >>> 8) & 255, n & 255]; }
function s4(s) { return [s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2), s.charCodeAt(3)]; }

// Build a box from a type and a flat array of byte values. Returns number[].
function box(type, bytes) {
  const size = 8 + bytes.length;
  return [...u32(size), ...s4(type), ...bytes];
}
function fullbox(type, version, flags, bytes) {
  return box(type, [version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255, ...bytes]);
}

const MATRIX = [
  ...u32(0x00010000), ...u32(0), ...u32(0),
  ...u32(0), ...u32(0x00010000), ...u32(0),
  ...u32(0), ...u32(0), ...u32(0x40000000),
];

export class Mp4Muxer {
  constructor(width, height, fps, { maxBytes = Infinity } = {}) {
    this.w = width;
    this.h = height;
    this.fps = fps;
    this.sampleDelta = Math.round(TIMESCALE / fps);
    this.samples = [];      // { size, keyframe }
    this.sampleData = [];    // Uint8Array per sample (mdat payload)
    this.avcC = null;        // AVCDecoderConfigurationRecord bytes
    this.mdatBytes = 0;
    this.maxBytes = maxBytes;
    this.limitReached = false;
  }

  // chunk: EncodedVideoChunk, meta: EncodedVideoChunkMetadata (first carries
  // decoderConfig.description = the avcC record)
  addChunk(chunk, meta) {
    if (this.mdatBytes + chunk.byteLength > this.maxBytes) {
      this.limitReached = true;
      return false;
    }
    if (!this.avcC && meta?.decoderConfig?.description) {
      this.avcC = new Uint8Array(meta.decoderConfig.description);
    }
    const buf = new Uint8Array(chunk.byteLength);
    chunk.copyTo(buf);
    this.sampleData.push(buf);
    this.samples.push({ size: buf.length, keyframe: chunk.type === 'key' });
    this.mdatBytes += buf.length;
    return true;
  }

  #avc1() {
    if (!this.avcC) throw new Error('mp4: encoder produced no avcC config');
    const avcC = box('avcC', [...this.avcC]);
    const entry = [
      0, 0, 0, 0, 0, 0,            // reserved
      ...u16(1),                    // data_reference_index
      ...u16(0), ...u16(0),         // predefined, reserved
      ...u32(0), ...u32(0), ...u32(0), // predefined[3]
      ...u16(this.w), ...u16(this.h),
      ...u32(0x00480000), ...u32(0x00480000), // 72dpi h/v resolution
      ...u32(0),                    // reserved
      ...u16(1),                    // frame_count
      ...new Array(32).fill(0),     // compressorname
      ...u16(0x0018),               // depth
      ...u16(0xffff),               // predefined
      ...avcC,
    ];
    return box('avc1', entry);
  }

  #stbl() {
    const n = this.samples.length;
    const stsd = fullbox('stsd', 0, 0, [...u32(1), ...this.#avc1()]);
    const stts = fullbox('stts', 0, 0, [...u32(1), ...u32(n), ...u32(this.sampleDelta)]);

    const keys = [];
    this.samples.forEach((s, i) => { if (s.keyframe) keys.push(i + 1); });
    const stss = fullbox('stss', 0, 0, [...u32(keys.length), ...keys.flatMap((k) => u32(k))]);

    const stsc = fullbox('stsc', 0, 0, [...u32(1), ...u32(1), ...u32(n), ...u32(1)]);
    const stsz = fullbox('stsz', 0, 0, [...u32(0), ...u32(n), ...this.samples.flatMap((s) => u32(s.size))]);
    // chunk offset: first sample sits right after ftyp + the 16-byte 64-bit
    // mdat header (near the file start, so a 32-bit stco offset is always safe)
    const chunkOffset = this.ftypLen + 16;
    const stco = fullbox('stco', 0, 0, [...u32(1), ...u32(chunkOffset)]);

    return box('stbl', [...stsd, ...stts, ...stss, ...stsc, ...stsz, ...stco]);
  }

  #moov(durationTs) {
    const mvhd = fullbox('mvhd', 0, 0, [
      ...u32(0), ...u32(0), ...u32(TIMESCALE), ...u32(durationTs),
      ...u32(0x00010000), ...u16(0x0100), ...u16(0), ...u32(0), ...u32(0),
      ...MATRIX, ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(0),
      ...u32(2), // next_track_id
    ]);
    const tkhd = fullbox('tkhd', 0, 0x000007, [
      ...u32(0), ...u32(0), ...u32(1), ...u32(0), ...u32(durationTs),
      ...u32(0), ...u32(0), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...MATRIX,
      ...u32(this.w << 16), ...u32(this.h << 16),
    ]);
    const mdhd = fullbox('mdhd', 0, 0, [
      ...u32(0), ...u32(0), ...u32(TIMESCALE), ...u32(durationTs),
      ...u16(0x55c4), ...u16(0), // 'und' language, predefined
    ]);
    const hdlr = fullbox('hdlr', 0, 0, [
      ...u32(0), ...s4('vide'), ...u32(0), ...u32(0), ...u32(0),
      ...s4('Vide'), 'o'.charCodeAt(0), 'H'.charCodeAt(0), 'a'.charCodeAt(0),
      'n'.charCodeAt(0), 'd'.charCodeAt(0), 'l'.charCodeAt(0), 'e'.charCodeAt(0), 'r'.charCodeAt(0), 0,
    ]);
    const vmhd = fullbox('vmhd', 0, 1, [...u16(0), ...u16(0), ...u16(0), ...u16(0)]);
    const url = fullbox('url ', 0, 1, []);
    const dref = fullbox('dref', 0, 0, [...u32(1), ...url]);
    const dinf = box('dinf', dref);
    const minf = box('minf', [...vmhd, ...dinf, ...this.#stbl()]);
    const mdia = box('mdia', [...mdhd, ...hdlr, ...minf]);
    const trak = box('trak', [...tkhd, ...mdia]);
    return box('moov', [...mvhd, ...trak]);
  }

  finalize() {
    const ftyp = box('ftyp', [
      ...s4('isom'), ...u32(0x200), // major brand, minor version
      ...s4('isom'), ...s4('iso2'), ...s4('avc1'), ...s4('mp41'),
    ]);
    this.ftypLen = ftyp.length;

    const durationTs = this.samples.length * this.sampleDelta;
    const moov = this.#moov(durationTs);
    // 64-bit "large size" mdat (size=1, real size in the trailing u64) so the
    // payload can exceed 4 GiB without the 32-bit size field wrapping
    const mdatHeader = [...u32(1), ...s4('mdat'), ...u64(16 + this.mdatBytes)];

    const parts = [
      new Uint8Array(ftyp),
      new Uint8Array(mdatHeader),
      ...this.sampleData,
      new Uint8Array(moov),
    ];
    return new Blob(parts, { type: 'video/mp4' });
  }

  release() {
    this.samples = [];
    this.sampleData = [];
    this.avcC = null;
    this.mdatBytes = 0;
  }
}
