/**
 * Writes a small animated placeholder USDZ (a ball on an arc) so mobile/API
 * integration can proceed before the real catch-and-shoot animation exists.
 * Replace it with the Blender export and bump the catalog version.
 *
 * USDZ = uncompressed ZIP whose file data starts on 64-byte boundaries.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { crc32 } from 'node:zlib';
import { join } from 'node:path';

const USDA = `#usda 1.0
(
    defaultPrim = "Placeholder"
    metersPerUnit = 1
    upAxis = "Y"
    startTimeCode = 0
    endTimeCode = 48
    timeCodesPerSecond = 24
)

def Xform "Placeholder" (
    kind = "component"
)
{
    def Sphere "Ball"
    {
        double radius = 0.12
        color3f[] primvars:displayColor = [(0.92, 0.45, 0.1)]
        float3 xformOp:translate.timeSamples = {
            0: (0, 1.0, 0),
            12: (0, 2.4, -0.8),
            24: (0, 2.9, -1.6),
            36: (0, 2.4, -2.4),
            48: (0, 1.0, -3.2),
        }
        uniform token[] xformOpOrder = ["xformOp:translate"]
    }
}
`;

export function buildUsdz(files: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data);
    const base = 30 + name.length + 4; // header + name + extra-field header
    const pad = (64 - ((offset + base) % 64)) % 64;
    const extra = Buffer.alloc(4 + pad);
    extra.writeUInt16LE(0x1986, 0); // same padding field id Apple's usdzip uses
    extra.writeUInt16LE(pad, 2);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(0, 6); // flags
    lh.writeUInt16LE(0, 8); // stored
    lh.writeUInt32LE(0, 10); // time/date
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(f.data.length, 18);
    lh.writeUInt32LE(f.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(extra.length, 28);
    locals.push(lh, name, extra, f.data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt32LE(0, 12);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(f.data.length, 20);
    ch.writeUInt32LE(f.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30); // extra
    ch.writeUInt16LE(0, 32); // comment
    ch.writeUInt16LE(0, 34); // disk
    ch.writeUInt16LE(0, 36); // internal attrs
    ch.writeUInt32LE(0, 38); // external attrs
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);

    offset += lh.length + name.length + extra.length + f.data.length;
  }
  const central = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, eocd]);
}

export function placeholderUsdz(): Buffer {
  return buildUsdz([{ name: 'placeholder.usda', data: Buffer.from(USDA, 'utf8') }]);
}

if (import.meta.filename === process.argv[1]) {
  const out = process.argv[2] ?? join(import.meta.dirname, '..', 'media', 'three-point-follow-through-v1.usdz');
  await mkdir(join(out, '..'), { recursive: true });
  const buf = placeholderUsdz();
  await writeFile(out, buf);
  console.log(`wrote ${out} (${buf.length} bytes)`);
}
