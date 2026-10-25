// Dev-only: builds small hand-made fixtures used by the browser checks and the
// Node harness. No dependencies.
//
//   node dev/make-fixtures.mjs
//
//  fixtures/colored-cube.glb  - 24 verts, normals + COLOR_0, 12 tris (v/vn + vc lines)
//  fixtures/pointcloud.glb    - 12000 scattered points, no indices, COLOR_0
//  fixtures/interleaved.gltf  - .gltf + interleaved.bin sidecar (byteStride 32: pos+nrm+col)

import fs from 'fs';
import path from 'path';

const root = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const outDir = path.join(root, 'fixtures');
fs.mkdirSync(outDir, { recursive: true });

function buildGlb(gltf, bin) {
  const jsonBuf = Buffer.from(JSON.stringify(gltf));
  const jp = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
  const bp = bin ? Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4, 0x00)]) : null;
  const total = 12 + 8 + jp.length + (bp ? 8 + bp.length : 0);
  const h = Buffer.alloc(12);
  h.writeUInt32LE(0x46546c67, 0);
  h.writeUInt32LE(2, 4);
  h.writeUInt32LE(total, 8);
  const jc = Buffer.alloc(8);
  jc.writeUInt32LE(jp.length, 0);
  jc.writeUInt32LE(0x4e4f534a, 4);
  if (!bp) return Buffer.concat([h, jc, jp]);
  const bc = Buffer.alloc(8);
  bc.writeUInt32LE(bp.length, 0);
  bc.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([h, jc, jp, bc, bp]);
}

// ---- colored cube with normals ----
{
  const faces = [
    [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, -1]],
    [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]],
    [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0], [-1, 0, 0]],
    [[1, 0, 0], [1, 0, 1], [1, 1, 1], [1, 1, 0], [1, 0, 0]],
    [[0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1], [0, 1, 0]],
    [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1], [0, -1, 0]],
  ];
  const colors = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [1, 0, 1], [0, 1, 1]];
  const pos = [], nrm = [], col = [], idx = [];
  faces.forEach((f, fi) => {
    const c = colors[fi];
    for (let v = 0; v < 4; v++) {
      pos.push(...f[v]); nrm.push(...f[4]); col.push(...c);
    }
    const b = fi * 4;
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  });
  const posB = Buffer.from(new Float32Array(pos).buffer);
  const nrmB = Buffer.from(new Float32Array(nrm).buffer);
  const colB = Buffer.from(new Float32Array(col).buffer);
  const idxB = Buffer.from(new Uint16Array(idx).buffer);
  const bin = Buffer.concat([posB, nrmB, colB, idxB]);
  const gltf = {
    asset: { version: '2.0', generator: 'glb2obj fixture' },
    scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name: 'cube', mesh: 0, translation: [0, 0, 0] }],
    meshes: [{ name: 'cube', primitives: [{ attributes: { POSITION: 0, NORMAL: 1, COLOR_0: 2 }, indices: 3 }] }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posB.length },
      { buffer: 0, byteOffset: posB.length, byteLength: nrmB.length },
      { buffer: 0, byteOffset: posB.length + nrmB.length, byteLength: colB.length },
      { buffer: 0, byteOffset: posB.length + nrmB.length + colB.length, byteLength: idxB.length },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 24, type: 'VEC3' },
      { bufferView: 1, componentType: 5126, count: 24, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: 24, type: 'VEC3' },
      { bufferView: 3, componentType: 5123, count: 36, type: 'SCALAR' },
    ],
  };
  const glb = buildGlb(gltf, bin);
  fs.writeFileSync(path.join(outDir, 'colored-cube.glb'), glb);
  console.log('colored-cube.glb', glb.length, 'bytes (24 verts, 12 tris, normals + colors)');
}

// ---- point cloud: no indices, colored ----
{
  const N = 12000;
  const pos = new Float32Array(N * 3);
  const col = new Float32Array(N * 3);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < N; i++) {
    // points on a sphere shell, so the preview should read as a hollow ball
    const u = rnd() * 2 - 1, t = rnd() * Math.PI * 2, r = 0.5 + rnd() * 0.05;
    const s = Math.sqrt(1 - u * u);
    pos[i * 3] = r * s * Math.cos(t);
    pos[i * 3 + 1] = r * s * Math.sin(t);
    pos[i * 3 + 2] = r * u;
    col[i * 3] = s; col[i * 3 + 1] = Math.abs(u); col[i * 3 + 2] = 1 - s;
  }
  const posB = Buffer.from(pos.buffer), colB = Buffer.from(col.buffer);
  const bin = Buffer.concat([posB, colB]);
  const gltf = {
    asset: { version: '2.0', generator: 'glb2obj fixture' },
    scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name: 'cloud', mesh: 0 }],
    meshes: [{ name: 'cloud', primitives: [{ attributes: { POSITION: 0, COLOR_0: 1 } }] }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posB.length },
      { buffer: 0, byteOffset: posB.length, byteLength: colB.length },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: N, type: 'VEC3' },
      { bufferView: 1, componentType: 5126, count: N, type: 'VEC3' },
    ],
  };
  const glb = buildGlb(gltf, bin);
  fs.writeFileSync(path.join(outDir, 'pointcloud.glb'), glb);
  console.log('pointcloud.glb', glb.length, 'bytes (' + N + ' points, no indices)');
}

// ---- .gltf + interleaved .bin sidecar (byteStride 32 = pos 12 + nrm 12 + col 8) ----
{
  const verts = [[0, 0, 0], [2, 0, 0], [2, 0, 2], [0, 0, 2]];
  const stride = 32;
  const bin = Buffer.alloc(stride * verts.length + 6);
  const dv = new DataView(bin.buffer);
  verts.forEach((v, i) => {
    dv.setFloat32(i * stride, v[0], true);
    dv.setFloat32(i * stride + 4, v[1], true);
    dv.setFloat32(i * stride + 8, v[2], true);
    dv.setFloat32(i * stride + 12, 0, true);
    dv.setFloat32(i * stride + 16, 1, true);
    dv.setFloat32(i * stride + 20, 0, true);
    dv.setUint8(i * stride + 24, 255, true);   // uint8 normalized color
    dv.setUint8(i * stride + 25, 128, true);
    dv.setUint8(i * stride + 26, 64, true);
  });
  const idxOff = stride * verts.length;
  dv.setUint16(idxOff, 0, true); dv.setUint16(idxOff + 2, 1, true); dv.setUint16(idxOff + 4, 2, true);
  const gltf = {
    asset: { version: '2.0', generator: 'glb2obj fixture' },
    scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name: 'interleaved', mesh: 0 }],
    meshes: [{ name: 'interleaved', primitives: [{ attributes: { POSITION: 0, NORMAL: 1, COLOR_0: 2 }, indices: 3 }] }],
    buffers: [{ uri: 'interleaved.bin', byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: stride * verts.length, byteStride: stride },
      { buffer: 0, byteOffset: 0, byteLength: stride * verts.length, byteStride: stride },
      { buffer: 0, byteOffset: 0, byteLength: stride * verts.length, byteStride: stride },
      { buffer: 0, byteOffset: stride * verts.length, byteLength: 6 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3' },
      { bufferView: 1, componentType: 5126, count: 4, type: 'VEC3', byteOffset: 12 },
      { bufferView: 2, componentType: 5121, count: 4, type: 'VEC3', byteOffset: 24, normalized: true },
      { bufferView: 3, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
  };
  fs.writeFileSync(path.join(outDir, 'interleaved.gltf'), JSON.stringify(gltf, null, 1));
  fs.writeFileSync(path.join(outDir, 'interleaved.bin'), bin);
  console.log('interleaved.gltf + interleaved.bin (4 verts, byteStride ' + stride + ', normalized uint8 colors)');
}
console.log('fixtures written to', outDir);
