// Dev-only: builds fixtures/draco-bunny.glb, a real KHR_draco_mesh_compression_ext
// GLB, by wrapping draco3dgltf's bunny.drc bitstream in a glTF container.
// Needs draco3dgltf installed somewhere reachable (see DRACO_PKG below); the
// product itself never needs this file or this script.
//
//   node dev/make-draco-fixture.mjs

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const root = path.join(here, '..');

// Candidate locations for the draco npm package (dev machine convenience).
const DRACO_PKG = [
  'draco3dgltf',
  path.join(root, 'node_modules', 'draco3dgltf'),
  'C:/Users/agmun/AppData/Local/Temp/dracotest/node_modules/draco3dgltf',
];
let draco = null, pkgUsed = null;
for (const p of DRACO_PKG) {
  try { draco = require(p); pkgUsed = p; break; } catch (e) { /* try next */ }
}
if (!draco) {
  console.error('draco3dgltf not found. Try: npm i draco3dgltf');
  process.exit(2);
}

const DT_TO_COMPONENT = { 1: 5120, 2: 5121, 3: 5122, 4: 5123, 5: 5125, 7: 5126 }; // draco DataType -> glTF componentType

const decModule = await draco.createDecoderModule({});
const drcPath = path.join(path.dirname(require.resolve(pkgUsed)), 'bunny.drc');
const raw = fs.readFileSync(drcPath);

const decoder = new decModule.Decoder();
const buffer = new decModule.DecoderBuffer();
buffer.Init(new Int8Array(raw), raw.byteLength);
const type = decoder.GetEncodedGeometryType(buffer);
if (type !== decModule.TRIANGULAR_MESH) throw new Error('expected a triangular mesh, got ' + type);
const mesh = new decModule.Mesh();
if (!decoder.DecodeBufferToMesh(buffer, mesh)) throw new Error('decode failed');
decModule.destroy(buffer);

const numPoints = mesh.num_points();
const numFaces = mesh.num_faces();
const attrNames = ['POSITION', 'NORMAL', 'COLOR', 'TEX_COORD'];
const found = [];
for (const name of attrNames) {
  const id = decoder.GetAttributeId(mesh, decModule[name]);
  if (id < 0) continue;
  const attribute = decoder.GetAttribute(mesh, id);
  const numComponents = attribute.num_components();
  const componentType = DT_TO_COMPONENT[attribute.data_type()] || 5126;
  const normalized = attribute.normalized();
  const gltfName = name === 'COLOR' ? 'COLOR_0' : name === 'TEX_COORD' ? 'TEXCOORD_0' : name;
  found.push({ gltfName, numComponents, componentType, normalized });
}
decModule.destroy(mesh);
decModule.destroy(decoder);

// --- assemble the GLB: draco bitstream in one bufferView, accessors carry only
// componentType/type/count (that is exactly what the extension needs) ---
const accessors = [];
const primAttrs = {};
for (const a of found) {
  const acc = { componentType: a.componentType, count: numPoints, type: 'VEC' + a.numComponents };
  if (a.normalized) acc.normalized = true;
  accessors.push(acc);
  primAttrs[a.gltfName] = accessors.length - 1;
}
accessors.push({ componentType: 5125, count: numFaces * 3, type: 'SCALAR' });
const indexAccessor = accessors.length - 1;

const gltf = {
  asset: { version: '2.0', generator: 'glb2obj draco fixture' },
  extensionsUsed: ['KHR_draco_mesh_compression_ext'],
  extensionsRequired: ['KHR_draco_mesh_compression_ext'],
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ name: 'bunny', mesh: 0 }],
  meshes: [{
    name: 'bunny',
    primitives: [{
      attributes: primAttrs,
      indices: indexAccessor,
      extensions: { KHR_draco_mesh_compression_ext: { bufferView: 0, attributes: primAttrs } },
    }],
  }],
  buffers: [{ byteLength: raw.length }],
  bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: raw.length }],
  accessors,
};

const jsonBuf = Buffer.from(JSON.stringify(gltf));
const jsonPadded = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
const binPadded = Buffer.concat([raw, Buffer.alloc((4 - (raw.length % 4)) % 4, 0x00)]);
const total = 12 + 8 + jsonPadded.length + 8 + binPadded.length;
const out = Buffer.alloc(total);
out.writeUInt32LE(0x46546c67, 0);
out.writeUInt32LE(2, 4);
out.writeUInt32LE(total, 8);
out.writeUInt32LE(jsonPadded.length, 12);
out.writeUInt32LE(0x4e4f534a, 16);
jsonPadded.copy(out, 20);
const o = 20 + jsonPadded.length;
out.writeUInt32LE(binPadded.length, o);
out.writeUInt32LE(0x004e4942, o + 4);
binPadded.copy(out, o + 8);

const dest = path.join(here, 'fixtures', 'draco-bunny.glb');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, out);
console.log('wrote ' + dest + ' (' + out.length + ' bytes) from ' + drcPath);
console.log('  points=' + numPoints + ' faces=' + numFaces + ' attrs=' + found.map((f) => f.gltfName).join(','));
console.log('  draco bitstream bytes=' + raw.length);
