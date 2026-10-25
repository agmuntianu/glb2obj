// Dev-only regression harness. The product is glb2obj.html; this file extracts
// the CORE block out of that HTML and runs it under Node.
//   node test.mjs
//
// Test 9 compares output byte-for-byte against the pre-rewrite Node converter
// (commit 71d8866), so the browser port cannot silently change results.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const html = fs.readFileSync(path.join(here, 'glb2obj.html'), 'utf8');
const block = html.match(/\/\* ==== CORE BEGIN ==== \*\/([\s\S]*?)\/\* ==== CORE END ==== \*\//);
if (!block) throw new Error('CORE block markers not found in glb2obj.html');
const { convertToObj, GlbError } = new Function(block[1] + '\nreturn { convertToObj, GlbError };')();
const convert = (i, o) => convertToObj(i, Object.assign({ collectObj: true }, o)).obj;
const convertFull = (i, o) => convertToObj(i, Object.assign({ collectObj: true }, o));

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

const faceVerts = (line) => line.slice(2).split(' ').map((t) => parseInt(t.split('/')[0], 10));

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
  const { obj, stats } = convertFull(buildGlb(gltf, bin));
  const lines = obj.trim().split('\n');
  for (const e of ['v 10 20 30', 'v 12 20 30', 'v 10 22 30', 'v 10 20 32']) {
    if (!lines.includes(e)) throw new Error('point cloud mismatch, missing: ' + e + '\n' + obj);
  }
  if (stats.points !== 4 || stats.faces !== 0) throw new Error('point cloud stats wrong');
  console.log('point cloud OK');
}

// 2. Indexed quad, uint16 indices
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
  const { obj, stats } = convertFull(buildGlb(gltf, bin));
  const lines = obj.trim().split('\n');
  if (!lines.includes('f 1 2 3') || !lines.includes('f 1 3 4')) throw new Error('quad faces wrong:\n' + obj);
  if (stats.points !== 4 || stats.faces !== 2) throw new Error('quad stats wrong');
  console.log('indexed mesh OK');
}

// 3. Multi-primitive face index offset
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
  const { obj, stats } = convertFull(buildGlb(gltf, bin));
  const faces = obj.trim().split('\n').filter((l) => l.startsWith('f ')).map(faceVerts);
  if (JSON.stringify(faces) !== JSON.stringify([[1, 2, 3], [1, 2, 3], [4, 5, 6], [4, 5, 6]])) {
    throw new Error('multi-primitive face offset wrong: ' + faces);
  }
  if (stats.points !== 6 || stats.faces !== 4) throw new Error('multi-primitive stats wrong');
  console.log('multi-primitive face offset OK');
}

// 4. Normals
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
  const { obj, stats } = convertFull(buildGlb(gltf, bin));
  const lines = obj.trim().split('\n');
  if (!lines.includes('vn 0 0 1')) throw new Error('vn missing:\n' + obj);
  if (!lines.includes('f 1/1 2/2 3/3')) throw new Error('f v/vn wrong:\n' + obj);
  if (stats.normals !== 3) throw new Error('normal stats wrong');
  console.log('normals OK');
}

// 5. Vertex colors, and colors off
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
  let r = convertFull(glb);
  let lines = r.obj.trim().split('\n');
  if (!lines.includes('vc 1 0 0') || !lines.includes('vc 0 1 0')) throw new Error('vc missing:\n' + r.obj);
  if (r.stats.colors !== 2) throw new Error('color stats wrong');
  r = convertFull(glb, { includeColors: false });
  if (r.obj.includes('vc ')) throw new Error('includeColors:false should drop vc lines');
  if (r.stats.colors !== 0) throw new Error('color stats wrong (off)');
  console.log('vertex colors OK');
}

// 6. Normalized int8
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
  const obj = convert(buildGlb(gltf, bin));
  if (!obj.trim().split('\n').includes('v -1 0 0.9921875')) throw new Error('int8 normalization wrong:\n' + obj);
  console.log('normalized ints OK');
}

// 7. .gltf JSON with data: URI
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
  const { obj, stats } = convertFull(JSON.stringify(gltf));
  if (stats.points !== 2) throw new Error('gltf JSON points wrong');
  if (!obj.includes('v 5 0 0')) throw new Error('gltf JSON verts wrong:\n' + obj);
  console.log('.gltf JSON + data: URI OK');
}

// 8. .gltf with external buffer supplied as a dropped sidecar (browser model)
{
  const pts = new Float32Array([1, 2, 3]);
  const gltf = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name: 'e', mesh: 0 }],
    meshes: [{ name: 'e', primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ uri: 'mesh.bin', byteLength: 12 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 12 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 1, type: 'VEC3' }],
  };
  const text = JSON.stringify(gltf);
  const sidecars = new Map([['mesh.bin', new Uint8Array(Buffer.from(pts.buffer))]]);
  const obj = convert(text, { sidecars });
  if (!obj.includes('v 1 2 3')) throw new Error('sidecar buffer wrong:\n' + obj);
  try {
    convert(text);
    throw new Error('should have thrown without sidecar');
  } catch (e) {
    if (!(e instanceof GlbError)) throw e;
    if (!/Drop the .gltf and its .bin/.test(e.message)) throw new Error('unhelpful sidecar error: ' + e.message);
  }
  console.log('external buffer via sidecar OK');
}

// 9. GOLDEN: real GLB must match the pre-rewrite Node converter byte-for-byte
{
  const file = path.join(here, 'ComfyUI_00002_.glb');
  if (!fs.existsSync(file)) { console.log('real GLB skipped (file missing)'); }
  else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glb2obj-golden-'));
    const oldDir = path.join(tmp, 'old');
    fs.mkdirSync(oldDir);
    const oldLib = execFileSync('git', ['show', '71d8866:lib/glb2obj.js'], { cwd: here, maxBuffer: 1 << 26 });
    fs.writeFileSync(path.join(oldDir, 'lib.js'), oldLib);
    const oldOut = path.join(tmp, 'golden.obj');
    execFileSync(process.execPath, ['-e',
      'const {convertGlbToObj}=require(' + JSON.stringify(path.join(oldDir, 'lib.js')) + ');' +
      'const fs=require("fs");' +
      'fs.writeFileSync(' + JSON.stringify(oldOut) + ', convertGlbToObj(fs.readFileSync(' + JSON.stringify(file) + ')).obj);',
    ]);
    const golden = fs.readFileSync(oldOut);

    const t0 = Date.now();
    const chunks = [];
    const { stats } = convertFull(fs.readFileSync(file), { onChunk: (c) => chunks.push(c) });
    const streamed = chunks.join('');
    const ms = Date.now() - t0;

    if (Buffer.byteLength(streamed) !== golden.length) {
      throw new Error('golden length mismatch: new ' + Buffer.byteLength(streamed) + ' vs old ' + golden.length);
    }
    if (Buffer.compare(Buffer.from(streamed), golden) !== 0) {
      let i = 0;
      while (i < golden.length && golden[i] === streamed.charCodeAt(i)) i++;
      throw new Error('golden byte mismatch at ' + i + ': old=' + JSON.stringify(golden.subarray(Math.max(0, i - 60), i + 40).toString()) +
        ' new=' + JSON.stringify(streamed.slice(Math.max(0, i - 60), i + 40)));
    }
    const maxChunk = Math.max(...chunks.map((c) => c.length));
    if (chunks.length < 2) throw new Error('expected streaming to split into multiple chunks, got ' + chunks.length);
    if (maxChunk > 2_000_000) throw new Error('chunk too big: ' + maxChunk);
    const lines = streamed.split('\n');
    const vCount = lines.filter((l) => l.startsWith('v ')).length;
    if (vCount !== stats.points) throw new Error('v count mismatch');
    for (const l of lines.filter((x) => x.startsWith('f ')).slice(0, 1000)) {
      const [a, b, c] = faceVerts(l);
      if (a < 1 || a > stats.points || b < 1 || b > stats.points || c < 1 || c > stats.points) {
        throw new Error('face index out of range: ' + l);
      }
    }
    console.log(`real GLB OK (byte-identical to baseline): ${stats.points} verts, ${stats.faces} faces, ` +
      `${(streamed.length / 1024 / 1024).toFixed(1)} MB in ${chunks.length} chunks (max ${(maxChunk / 1024) | 0} KB), ${ms} ms`);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// 10. Interleaved POSITION+NORMAL with byteStride (the old code read a
// non-existent "bytesPerElement" field and mis-strided these)
{
  const stride = 24; // pos(12) + normal(12)
  const bin = Buffer.alloc(stride * 3);
  const dv = new DataView(bin.buffer);
  const verts = [[0, 0, 0], [1, 0, 0], [0, 1, 0]];
  const nrms = [[0, 0, 1], [0, 1, 0], [1, 0, 0]];
  for (let i = 0; i < 3; i++) {
    for (let c = 0; c < 3; c++) {
      dv.setFloat32(i * stride + c * 4, verts[i][c], true);
      dv.setFloat32(i * stride + 12 + c * 4, nrms[i][c], true);
    }
  }
  const idx = Buffer.from(new Uint16Array([0, 1, 2]).buffer);
  const buf = Buffer.concat([bin, idx]);
  const gltf = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name: 'il', mesh: 0 }],
    meshes: [{ name: 'il', primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2 }] }],
    buffers: [{ byteLength: buf.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: bin.length, byteStride: stride },
      { buffer: 0, byteOffset: 0, byteLength: bin.length, byteStride: stride },
      { buffer: 0, byteOffset: bin.length, byteLength: idx.length },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3', byteOffset: 12 },
      { bufferView: 2, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
  };
  const obj = convert(buildGlb(gltf, buf));
  const lines = obj.trim().split('\n');
  for (const e of ['v 0 0 0', 'v 1 0 0', 'v 0 1 0']) {
    if (!lines.includes(e)) throw new Error('interleaved positions wrong (stride ignored?):\n' + obj);
  }
  for (const e of ['vn 0 0 1', 'vn 0 1 0', 'vn 1 0 0']) {
    if (!lines.includes(e)) throw new Error('interleaved normals wrong:\n' + obj);
  }
  console.log('interleaved byteStride OK');
}

// 11. Preview geometry for the WebGL view
{
  const pts = [[0, 0, 0], [1, 0, 0], [1, 1, 0]];
  const bin = Buffer.concat([
    Buffer.from(new Float32Array(pts.flat()).buffer),
    Buffer.from(new Uint16Array([0, 1, 2]).buffer),
  ]);
  const gltf = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name: 'pv', mesh: 0 }],
    meshes: [{ name: 'pv', primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 6 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
  };
  const r = convertToObj(buildGlb(gltf, bin), { collectObj: false, collectPreview: true });
  if (r.obj !== null) throw new Error('collectObj:false should skip text building');
  const pv = r.preview;
  if (!pv || pv.verts.length !== 1 || pv.verts[0].length !== 9) throw new Error('preview verts wrong');
  if (pv.verts[0][3] !== 1) throw new Error('preview vert data wrong');
  if (pv.edges.length !== 1 || pv.edges[0].index.length !== 3) throw new Error('preview edges wrong');
  if (r.stats.points !== 3) throw new Error('preview stats wrong');
  console.log('preview geometry OK');
}

// 12. Cyclic / self-parenting hierarchy must not hang
{
  const pts = new Float32Array([0, 0, 0]);
  const bin = Buffer.from(pts.buffer);
  const gltf = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name: 'loop', mesh: 0, children: [0] }],
    meshes: [{ name: 'loop', primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 1, type: 'VEC3' }],
  };
  const obj = convert(buildGlb(gltf, bin));
  if (!obj.includes('v 0 0 0')) throw new Error('cycle guard broke geometry');
  console.log('hierarchy cycle guard OK');
}

// 13. Bad magic
{
  try { convert(Buffer.from('not a glb file at all!!')); throw new Error('should have thrown'); }
  catch (e) { if (!/bad magic/.test(e.message)) throw e; }
  console.log('bad-magic rejection OK');
}

// 14. Out-of-bounds bufferView -> GlbError, not RangeError
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
    convert(buildGlb(gltf, bin));
    throw new Error('should have thrown');
  } catch (e) { if (!(e instanceof GlbError)) throw e; }
  console.log('bounds check OK');
}

// 15. Accessor count beyond the view -> GlbError
{
  const bin = Buffer.from(new Float32Array([0, 0, 0]).buffer);
  const gltf = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name: 'a', mesh: 0 }],
    meshes: [{ name: 'a', primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 99, type: 'VEC3' }],
  };
  try {
    convert(buildGlb(gltf, bin));
    throw new Error('should have thrown');
  } catch (e) { if (!(e instanceof GlbError)) throw e; }
  console.log('accessor bounds check OK');
}

console.log('ALL TESTS PASSED');
