/**
 * Minimal NumPy .npz reader: a zip (stored or deflated) of .npy v1/v2/v3 files.
 * Supports little-endian, C-order numeric arrays (<f4 <f8 <i1 <i2 <i4 <i8 <u1 <u2 <u4 |b1)
 * and fixed-width unicode (<U*). Object arrays (|O, i.e. pickles) are rejected:
 * never unpickle data that came from outside.
 */
import { unzipSync } from 'fflate';

export type NpyData = Float32Array | Float64Array | Int8Array | Int16Array | Int32Array | Uint8Array | Uint16Array | Uint32Array;

export interface NpyArray {
  dtype: string;
  shape: number[];
  /** Numeric arrays: a typed array (int64 is converted to Float64Array; values must be safe integers). */
  data: NpyData | string[];
}

export class NpzError extends Error {}

const NUMERIC: Record<string, { bytes: number; read: (buf: ArrayBuffer, n: number) => NpyData }> = {
  '<f4': { bytes: 4, read: (b) => new Float32Array(b) },
  '<f8': { bytes: 8, read: (b) => new Float64Array(b) },
  '|i1': { bytes: 1, read: (b) => new Int8Array(b) },
  '<i2': { bytes: 2, read: (b) => new Int16Array(b) },
  '<i4': { bytes: 4, read: (b) => new Int32Array(b) },
  '|u1': { bytes: 1, read: (b) => new Uint8Array(b) },
  '<u2': { bytes: 2, read: (b) => new Uint16Array(b) },
  '<u4': { bytes: 4, read: (b) => new Uint32Array(b) },
  '|b1': { bytes: 1, read: (b) => new Uint8Array(b) },
  '<i8': {
    bytes: 8,
    read: (b, n) => {
      const src = new BigInt64Array(b);
      const out = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const v = src[i]!;
        if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) throw new NpzError('int64 value outside the safe integer range');
        out[i] = Number(v);
      }
      return out;
    },
  },
};
if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) throw new Error('npz reader assumes a little-endian host');

/** Parses one .npy file. */
export function parseNpy(bytes: Uint8Array, name = 'array'): NpyArray {
  if (bytes.length < 10 || bytes[0] !== 0x93 || String.fromCharCode(...bytes.subarray(1, 6)) !== 'NUMPY') {
    throw new NpzError(`${name}: not an .npy file`);
  }
  const major = bytes[6]!;
  if (major < 1 || major > 3) throw new NpzError(`${name}: unsupported .npy version ${major}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLen = major === 1 ? view.getUint16(8, true) : view.getUint32(8, true);
  const headerStart = major === 1 ? 10 : 12;
  const dataStart = headerStart + headerLen;
  if (dataStart > bytes.length) throw new NpzError(`${name}: truncated header`);
  const header = new TextDecoder(major === 3 ? 'utf-8' : 'latin1').decode(bytes.subarray(headerStart, dataStart));

  const descr = /'descr':\s*'([^']+)'/.exec(header)?.[1];
  const fortran = /'fortran_order':\s*(True|False)/.exec(header)?.[1];
  const shapeText = /'shape':\s*\(([^)]*)\)/.exec(header)?.[1];
  if (!descr || !fortran || shapeText === undefined) throw new NpzError(`${name}: malformed header`);
  if (descr.includes('O')) throw new NpzError(`${name}: object arrays (pickles) are not accepted`);
  if (fortran === 'True') throw new NpzError(`${name}: Fortran-order arrays are not supported`);
  const shape = shapeText
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const n = Number(s.replace(/L$/, ''));
      if (!Number.isSafeInteger(n) || n < 0) throw new NpzError(`${name}: bad shape`);
      return n;
    });
  const count = shape.reduce((a, b) => a * b, 1);
  const body = bytes.subarray(dataStart);

  const unicode = /^<U(\d+)$/.exec(descr);
  if (unicode) {
    const width = Number(unicode[1]);
    if (body.length < count * width * 4) throw new NpzError(`${name}: truncated data`);
    const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const out: string[] = [];
    for (let i = 0; i < count; i++) {
      let s = '';
      for (let c = 0; c < width; c++) {
        const cp = dv.getUint32((i * width + c) * 4, true);
        if (cp === 0) break;
        s += String.fromCodePoint(cp);
      }
      out.push(s);
    }
    return { dtype: descr, shape, data: out };
  }

  const kind = NUMERIC[descr === '<b1' ? '|b1' : descr];
  if (!kind) throw new NpzError(`${name}: unsupported dtype ${descr}`);
  const size = count * kind.bytes;
  if (body.length < size) throw new NpzError(`${name}: truncated data`);
  // Copy so the typed array starts on an aligned offset.
  const aligned = body.slice(0, size).buffer;
  return { dtype: descr, shape, data: kind.read(aligned, count) };
}

/** Parses an .npz archive into its arrays, keyed by name without the .npy suffix. */
export function readNpz(bytes: Uint8Array, opts: { maxUncompressedBytes?: number } = {}): Record<string, NpyArray> {
  const max = opts.maxUncompressedBytes ?? 512 * 1024 * 1024;
  let files: Record<string, Uint8Array>;
  let total = 0;
  try {
    files = unzipSync(bytes, {
      filter: (f) => {
        total += f.originalSize;
        if (total > max) throw new NpzError('npz is larger than allowed when uncompressed');
        return f.name.endsWith('.npy');
      },
    });
  } catch (err) {
    if (err instanceof NpzError) throw err;
    throw new NpzError(`not a valid npz archive: ${(err as Error).message}`);
  }
  const out: Record<string, NpyArray> = {};
  for (const [file, data] of Object.entries(files)) {
    const key = file.replace(/\.npy$/, '');
    out[key] = parseNpy(data, key);
  }
  if (Object.keys(out).length === 0) throw new NpzError('npz holds no arrays');
  return out;
}

export function scalar(a: NpyArray | undefined, name: string): number {
  if (!a || typeof a.data[0] !== 'number' || a.data.length !== 1) throw new NpzError(`${name} must be a numeric scalar`);
  return a.data[0];
}
