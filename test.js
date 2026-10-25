'use strict';
// Tests: synthetic point cloud, synthetic indexed mesh, multi-primitive mesh,
// normals, vertex colors, normalized ints, .gltf JSON, external buffers, real GLB.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { convertGlbToObj, GlbError } = require('./lib/glb2obj');

function buildGlb(gltf, bin) {
  const jsonBuf = Buffer.from(JSON.stringify(gltf));
  const jp = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
  const h = Buffer.alloc(12);
  h.writeUInt32LE(0x46546c67, 0);
  h.writeUInt32LE(2, 4);
  h.writeUInt32LE(12 + 8 + jp.length + (bin ? 8 + bin.length : 0), 8);
  const jc = Buffer.alloc(8);
  jc.writeUInt32LE(jp.length, 0);
  jc.writeUInt32LE(0x4e4f534a, 4);
  if (!bin) return Buffer.concat([h, jc, jp]);
  const bc = Buffer.alloc(8);
  bc.writeUInt32LE(bin.length, 0);
  bc.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([h, jc, jp, bc, bin]);
}

function faceVerts(line) { // 'f a b c' or 'f a/na b/nb c/nc' -> vertex indices
  return line.slice(2).split(' ').map((t) => parseInt(t.split('/')[0], 10));
}

// 1. Point cloud with node TRS
{
  const pts = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const bin = Buffer.from(new Float32Array(pts.flat()).buffer);
  const gltf = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name: 'cloud', mesh: 0, translation: [10, 20, 30], scale: [2, 2, 2] }],
    meshes: [{ name: 'cloud', primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 4, type: 'VEC3' }],
  };
  const { obj, stats } = convertGlbToObj(buildGlb(gltf, bin));
  const lines = obj.trim().split('\n');
  const expected = ['v 10 20 30', 'v 12 20 30', 'v 10 22 30', 'v 10 20 32'];
  for (const e of expected) if (!lines.includes(e)) throw new Error('point cloud mismatch, missing: ' + e + '\n' + obj);
  if (stats.points !== 4 || stats.faces !== 0) throw new Error('point cloud stats wrong');
  console.log('point cloud OK');
}

// 2. Indexed triangle mesh (quad = 2 tris), uint16 indices
{
  const pts = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
  const posBuf = Buffer.from(new Float32Array(pts.flat()).buffer);
  const idxBuf = Buffer.from(new Uint16Array([0, 1, 2, 0, 2, 3]).buffer);
  const bin = Buffer.concat([posBuf, idxBuf]);
  const gltf = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name: 'quad', mesh: 0 }],
    meshes: [{ name: 'quad', primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posBuf.length },
      { buffer: 0, byteOffset: posBuf.length, byteLength: idxBuf.length },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3' },
      { bufferView: 1, componentType: 5123, count: 6, type: 'SCALAR' },
    ],
  };
  const { obj, stats } = convertGlbToObj(buildGlb(gltf, bin));
  const lines = obj.trim().split('\n');
  if (!lines.includes('f 1 2 3') || !lines.includes('f 1 3 4')) throw new Error('quad faces wrong:\n' + obj);
  if (stats.points !== 4 || stats.faces !== 2) throw new Error('quad stats wrong');
  console.log('indexed mesh OK');
}

// 3. Multi-primitive mesh: face indices of 2nd primitive must offset by its vert base
{
  const tri1 = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const tri2 = new Float32Array([10, 0, 0, 11, 0, 0, 10, 1, 0]);
  const idx = new Uint16Array([0, 1, 2, 0, 1, 2]);
  const bin = Buffer.concat([Buffer.from(tri1.buffer), Buffer.from(tri2.buffer), Buffer.from(idx.buffer)]);
  const gltf = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name: 'two', mesh: 0 }],
    meshes: [{ name: 'two', primitives: [
      { attributes: { POSITION: 0 }, indices: 2 },
      { attributes: { POSITION: 1 }, indices: 2 },
    ] }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 36 },
      { buffer: 0, byteOffset: 72, byteLength: 12 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: 6, type: 'SCALAR' },
    ],
  };
  const { obj, stats } = convertGlbToObj(buildGlb(gltf, bin));
  const lines = obj.trim().split('\n');
  const faces = lines.filter((l) => l.startsWith('f ')).map(faceVerts);
  // shared indices accessor (6 indices = 2 tris) used by both primitives
  if (JSON.stringify(faces) !== JSON.stringify([[1, 2, 3], [1, 2, 3], [4, 5, 6], [4, 5, 6]])) throw new Error('multi-primitive face offset wrong: ' + faces);
  if (stats.points !== 6 || stats.faces !== 4) throw new Error('multi-primitive stats wrong');
  console.log('multi-primitive face offset OK');
}

// 4. Normals -> vn lines + f v/vn
{
  const pts = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const nrm = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const idx = new Uint16Array([0, 1, 2]);
  const bin = Buffer.concat([Buffer.from(pts.buffer), Buffer.from(nrm.buffer), Buffer.from(idx.buffer)]);
  const gltf = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name: 'n', mesh: 0 }],
    meshes: [{ name: 'n', primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2 }] }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 36 },
      { buffer: 0, byteOffset: 72, byteLength: 6 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
  };
  const { obj, stats } = convertGlbToObj(buildGlb(gltf, bin));
  const lines = obj.trim().split('\n');
  if (!lines.includes('vn 0 0 1')) throw new Error('vn missing:\n' + obj);
  if (!lines.includes('f 1/1 2/2 3/3')) throw new Error('f v/vn wrong:\n' + obj);
  if (stats.normals !== 3) throw new Error('normal stats wrong');
  console.log('normals OK');
}

// 5. Vertex colors -> vc lines (and --no-colors equivalent via includeColors:false)
{
  const pts = new Float32Array([0, 0, 0, 1, 0, 0]);
  const col = new Float32Array([1, 0, 0, 0, 1, 0]);
  const bin = Buffer.concat([Buffer.from(pts.buffer), Buffer.from(col.buffer)]);
  const gltf = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name: 'c', mesh: 0 }],
    meshes: [{ name: 'c', primitives: [{ attributes: { POSITION: 0, COLOR_0: 1 } }] }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 24 },
      { buffer: 0, byteOffset: 24, byteLength: 24 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 2, type: 'VEC3' },
      { bufferView: 1, componentType: 5126, count: 2, type: 'VEC3' },
    ],
  };
  const glb = buildGlb(gltf, bin);
  let { obj, stats } = convertGlbToObj(glb);
  let lines = obj.trim().split('\n');
  if (!lines.includes('vc 1 0 0') || !lines.includes('vc 0 1 0')) throw new Error('vc missing:\n' + obj);
  if (stats.colors !== 2) throw new Error('color stats wrong');
  ({ obj, stats } = convertGlbToObj(glb, { includeColors: false }));
  if (obj.includes('vc ')) throw new Error('includeColors:false should drop vc lines');
  if (stats.colors !== 0) throw new Error('color stats wrong (off)');
  console.log('vertex colors OK');
}

// 6. Normalized int8/uint8 accessors
{
  const pos = new Int8Array([-128, 0, 127, 0, 0, 0]);
  const bin = Buffer.from(pos.buffer);
  const gltf = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name: 'i', mesh: 0 }],
    meshes: [{ name: 'i', primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length }],
    accessors: [{ bufferView: 0, componentType: 5120, count: 2, type: 'VEC3', normalized: true }],
  };
  const { obj } = convertGlbToObj(buildGlb(gltf, bin));
  const lines = obj.trim().split('\n');
  if (!lines.includes('v -1 0 0.9921875')) throw new Error('int8 normalization wrong:\n' + obj);
  console.log('normalized ints OK');
}

// 7. .gltf JSON with data: URI buffer
{
  const pts = new Float32Array([0, 0, 0, 5, 0, 0]);
  const b64 = Buffer.from(pts.buffer).toString('base64');
  const gltf = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name: 'j', mesh: 0 }],
    meshes: [{ name: 'j', primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ uri: 'data:application/octet-stream;base64,' + b64, byteLength: 24 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 24 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 2, type: 'VEC3' }],
  };
  const { obj, stats } = convertGlbToObj(JSON.stringify(gltf));
  if (stats.points !== 2) throw new Error('gltf JSON points wrong');
  if (!obj.includes('v 5 0 0')) throw new Error('gltf JSON verts wrong:\n' + obj);
  console.log('.gltf JSON OK');
}

// 8. .gltf with external buffer file (basePath)
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glb2obj-'));
  const pts = new Float32Array([1, 2, 3]);
  fs.writeFileSync(path.join(dir, 'bin.bin'), Buffer.from(pts.buffer));
  const gltf = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name: 'e', mesh: 0 }],
    meshes: [{ name: 'e', primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ uri: 'bin.bin', byteLength: 12 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 12 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 1, type: 'VEC3' }],
  };
  const { obj } = convertGlbToObj(JSON.stringify(gltf), { basePath: dir });
  if (!obj.includes('v 1 2 3')) throw new Error('external buffer wrong:\n' + obj);
  // without basePath -> clean GlbError
  try {
    convertGlbToObj(JSON.stringify(gltf));
    throw new Error('should have thrown');
  } catch (e) {
    if (!(e instanceof GlbError)) throw e;
  }
  fs.rmSync(dir, { recursive: true });
  console.log('external buffer OK');
}

// 9. Real GLB
{
  const file = path.join(__dirname, 'ComfyUI_00002_.glb');
  if (fs.existsSync(file)) {
    const t0 = Date.now();
    const { obj, stats } = convertGlbToObj(fs.readFileSync(file));
    const lines = obj.split('\n');
    const vCount = lines.filter((l) => l.startsWith('v ')).length;
    const fCount = lines.filter((l) => l.startsWith('f ')).length;
    if (vCount !== stats.points) throw new Error('v count mismatch');
    // validate faces: indices in range
    for (const l of lines.filter((x) => x.startsWith('f ')).slice(0, 1000)) {
      const [a, b, c] = faceVerts(l);
      if (a < 1 || a > stats.points || b < 1 || b > stats.points || c < 1 || c > stats.points)
        throw new Error('face index out of range: ' + l);
    }
    console.log(`real GLB OK: ${stats.points} verts, ${stats.faces} faces, ${(obj.length / 1024 / 1024).toFixed(1)} MB obj, ${Date.now() - t0} ms`);
  } else {
    console.log('real GLB skipped (file missing)');
  }
}

// 10. Bad magic
{
  const bad = Buffer.from('not a glb file at all!!');
  try { convertGlbToObj(bad); throw new Error('should have thrown'); }
  catch (e) { if (!/bad magic/.test(e.message)) throw e; }
  console.log('bad-magic rejection OK');
}

// 11. Out-of-bounds bufferView -> clean GlbError (not RangeError)
{
  const bin = Buffer.from(new Float32Array([0, 0, 0]).buffer);
  const gltf = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name: 'b', mesh: 0 }],
    meshes: [{ name: 'b', primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: 1024 }],
    bufferViews: [{ buffer: 0, byteOffset: 1000, byteLength: 64 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 1, type: 'VEC3' }],
  };
  try {
    convertGlbToObj(buildGlb(gltf, bin));
    throw new Error('should have thrown');
  } catch (e) {
    if (!(e instanceof GlbError)) throw e;
  }
  console.log('bounds check OK');
}

console.log('ALL TESTS PASSED');
