/**
 * Writes a small animated placeholder USDZ (a ball on an arc) so mobile/API
 * integration can proceed before the real catch-and-shoot animation exists.
 * Replace it with the Blender export and bump the catalog version.
 *
 * USDZ = uncompressed ZIP whose file data starts on 64-byte boundaries.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { buildUsdz as buildArchive } from '../../mobile/src/core/usdz.js';

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
  return Buffer.from(buildArchive(files));
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
