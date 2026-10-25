// Dev-only regression harness. The product is glb2obj.html; this file extracts
// the CORE block out of that HTML and runs it under Node.
//   node dev/test.mjs
//
// Test 9 compares output byte-for-byte against the pre-rewrite Node converter (the
// repo's first commit, which still contains lib/glb2obj.js), so the browser port
// cannot silently change results. It skips if that history was squashed away.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
import { execFileSync } from 'child_process';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const html = fs.readFileSync(path.join(here, '..', 'glb2obj.html'), 'utf8');
const block = html.match(/\/\* ==== CORE BEGIN ==== \*\/([\s\S]*?)\/\* ==== CORE END ==== \*\//);
if (!block) throw new Error('CORE block markers not found in glb2obj.html');
const { convertToObj, convertGEN, GlbError, setDracoModule, peekExtensions } = new Function(
  block[1] + '\nreturn { convertToObj, convertGEN, GlbError, setDracoModule, peekExtensions };'
)();
const convert = (i, o) => convertToObj(i, Object.assign({ collectObj: true }, o)).obj;
const convertFull = (i, o) => convertToObj(i, Object.assign({ collectObj: true }, o));

// Fixtures are generated, not committed — except draco-bunny.glb, which needs a real
// Draco encoder to build and would otherwise leave the Draco path untested. Build any
// missing generated fixture on demand so a fresh clone can still run the suite.
const fixtureDir = path.join(here, 'fixtures');
for (const f of ['colored-cube.glb', 'pointcloud.glb', 'interleaved.gltf', 'interleaved.bin']) {
  if (!fs.existsSync(path.join(fixtureDir, f))) {
    execFileSync(process.execPath, [path.join(here, 'make-fixtures.mjs')], { stdio: 'ignore' });
    break;
  }
}

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
    if (!/Drop the \.gltf together with its \.bin/.test(e.message)) throw new Error('unhelpful sidecar error: ' + e.message);
  }
  console.log('external buffer via sidecar OK');
}

// 9. GOLDEN: real GLB must match the pre-rewrite Node converter byte-for-byte
{
  const file = path.join(here, '..', 'sample-mouse.glb');
  if (!fs.existsSync(file)) { console.log('real GLB skipped (file missing)'); }
  else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glb2obj-golden-'));
    const oldDir = path.join(tmp, 'old');
    fs.mkdirSync(oldDir);
    let oldLib;
    try {
      const base = execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: here }).toString().trim().split('\n')[0];
      oldLib = execFileSync('git', ['show', base + ':lib/glb2obj.js'], { cwd: here, maxBuffer: 1 << 26 });
    } catch (e) {
      console.log('real GLB golden check skipped (pre-rewrite converter not reachable in this clone)');
      fs.rmSync(tmp, { recursive: true, force: true });
      oldLib = null;
    }
    if (oldLib) {
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
    // generator must yield progress often enough to keep the UI responsive
    const g = convertGEN(fs.readFileSync(file), { onChunk: () => {} });
    let yields = 0;
    while (!g.next().done) yields++;
    if (yields < 20) throw new Error('generator yielded only ' + yields + ' times - too coarse for progress');
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
  if (!pv || pv.count !== 3) throw new Error('preview count wrong');
  if (pv.positions.length !== 9 || pv.positions[3] !== 1) throw new Error('preview vertex data wrong');
  if (pv.triCount !== 1 || pv.triangles.length !== 3) throw new Error('preview triangles wrong');
  if (JSON.stringify(Array.from(pv.triangles)) !== JSON.stringify([0, 1, 2])) throw new Error('preview triangle indices wrong');
  if (JSON.stringify(pv.bbox) !== JSON.stringify([0, 0, 0, 1, 1, 0])) throw new Error('preview bbox wrong: ' + pv.bbox);
  if (pv.colors !== null) throw new Error('preview should have no colors here');
  if (!pv.normalsGenerated) throw new Error('test 11 fixture has no NORMAL, so preview normals are generated');
  if (r.stats.points !== 3) throw new Error('preview stats wrong');
  console.log('preview geometry OK');
}

// 12. Preview normals: generated when the file has none, taken from the file when it does
{
  const mk = (attrs, accs, extra) => {
    const pts = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const parts = [Buffer.from(pts.buffer)];
    if (extra) parts.push(Buffer.from(extra.buffer));
    parts.push(Buffer.from(new Uint16Array([0, 1, 2]).buffer));
    const bin = Buffer.concat(parts);
    return buildGlb({
      asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
      nodes: [{ name: 'nrm', mesh: 0 }],
      meshes: [{ name: 'nrm', primitives: [{ attributes: attrs, indices: accs.indices }] }],
      buffers: [{ byteLength: bin.length }],
      bufferViews: accs.views,
      accessors: accs.list,
    }, bin);
  };
  // no NORMAL attribute -> generated, CCW in XY plane should point +Z
  const a = mk({ POSITION: 0 }, {
    views: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 6 }],
    list: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
           { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' }],
    indices: 1,
  });
  const p1 = convertToObj(a, { collectObj: false, collectPreview: true }).preview;
  if (!p1.normals || !p1.normalsGenerated) throw new Error('expected generated preview normals');
  for (let i = 0; i < 3; i++) {
    const nz = p1.normals[i * 3 + 2];
    if (Math.abs(nz - 1) > 1e-6) throw new Error('generated normal should be +Z, got ' + p1.normals[i * 3] + ',' + p1.normals[i * 3 + 1] + ',' + nz);
  }
  // NORMAL present -> use the file's normals, not generated ones
  const nrm = new Float32Array([0, 0, 1, 0, 1, 0, 1, 0, 0]);
  const b = mk({ POSITION: 0, NORMAL: 1 }, {
    views: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 36 }, { buffer: 0, byteOffset: 72, byteLength: 6 }],
    list: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
           { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
           { bufferView: 2, componentType: 5123, count: 3, type: 'SCALAR' }],
    indices: 2,
  }, nrm);
  const p2 = convertToObj(b, { collectObj: false, collectPreview: true }).preview;
  if (p2.normalsGenerated) throw new Error('file normals must not be marked generated');
  if (p2.normals[2] !== 1 || p2.normals[4] !== 1 || p2.normals[6] !== 1) throw new Error('file normals not passed through: ' + Array.from(p2.normals));
  // point cloud -> no faces, so no normals at all
  const pc = convertToObj(buildGlb({
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name: 'pc', mesh: 0 }],
    meshes: [{ name: 'pc', primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: 12 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 12 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 1, type: 'VEC3' }],
  }, Buffer.from(new Float32Array([1, 2, 3]).buffer)), { collectObj: false, collectPreview: true }).preview;
  if (pc.normals !== null) throw new Error('point cloud should have no normals');
  console.log('preview normals OK (generated vs from-file vs point cloud)');
}

// 13. One single giant primitive still yields repeatedly (no frozen tab)
{
  const N = 100000;
  const pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) { pos[i * 3] = i; pos[i * 3 + 1] = 0; pos[i * 3 + 2] = 0; }
  const bin = Buffer.from(pos.buffer);
  const gltf = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name: 'big', mesh: 0 }],
    meshes: [{ name: 'big', primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length }],
    accessors: [{ bufferView: 0, componentType: 5126, count: N, type: 'VEC3' }],
  };
  const g = convertGEN(buildGlb(gltf, bin), { onChunk: () => {} });
  let yields = 0, r;
  while (!(r = g.next()).done) yields++;
  if (yields < 10) throw new Error('single-primitive model yielded only ' + yields + ' times');
  if (r.value.stats.points !== N) throw new Error('big single-primitive point count wrong');
  console.log('generator granularity OK (' + yields + ' yields for one 100k-point primitive)');
}

// 13. Cyclic / self-parenting hierarchy must not hang
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

// 14. Bad magic
{
  try { convert(Buffer.from('not a glb file at all!!')); throw new Error('should have thrown'); }
  catch (e) { if (!/bad magic/.test(e.message)) throw e; }
  console.log('bad-magic rejection OK');
}

// 15. Out-of-bounds bufferView -> GlbError, not RangeError
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

// 16. Accessor count beyond the view -> GlbError
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

// 17. Draco: real KHR_draco_mesh_compression_ext GLB (fixtures/draco-bunny.glb)
{
  const fixture = path.join(here, 'fixtures', 'draco-bunny.glb');
  if (!fs.existsSync(fixture)) {
    console.log('draco skipped (fixtures/draco-bunny.glb missing - run node dev/make-draco-fixture.mjs)');
  } else {
    const data = fs.readFileSync(fixture);
    if (!peekExtensions(data).includes('KHR_draco_mesh_compression_ext')) throw new Error('peekExtensions missed the draco extension');

    // no decoder installed -> actionable error, not a crash
    setDracoModule(null);
    try {
      convertToObj(data);
      throw new Error('expected a helpful error without a decoder');
    } catch (e) {
      if (!(e instanceof GlbError)) throw e;
      if (!/decoder is not loaded/.test(e.message)) throw new Error('unhelpful draco error: ' + e.message);
    }

    // real decoder if draco3dgltf happens to be installed (dev-only, optional)
    let draco = null;
    const req = createRequire(import.meta.url);
    for (const p of ['draco3dgltf', path.join(here, '..', 'node_modules', 'draco3dgltf'), path.join(here, 'node_modules', 'draco3dgltf'), 'C:/Users/agmun/AppData/Local/Temp/dracotest/node_modules/draco3dgltf']) {
      try { draco = req(p); break; } catch (e) { /* optional */ }
    }
    if (!draco) { console.log('draco decode skipped (draco3dgltf not installed) - error path only'); }
    else {
      const mod = await draco.createDecoderModule({});
      setDracoModule(mod);
      const { obj, stats } = convertToObj(data, { collectObj: true });
      if (stats.points !== 34834) throw new Error('draco points wrong: ' + stats.points);
      if (stats.faces !== 69451) throw new Error('draco faces wrong: ' + stats.faces);
      if (stats.normals !== 34834) throw new Error('draco normals wrong: ' + stats.normals);
      if (stats.draco !== 1) throw new Error('draco primitive not counted');
      const lines = obj.trim().split('\n');
      if (lines.filter((l) => l.startsWith('v ')).length !== 34834) throw new Error('draco v lines wrong');
      if (lines.filter((l) => l.startsWith('vn ')).length !== 34834) throw new Error('draco vn lines wrong');
      if (!lines.some((l) => /^f \d+\/\d+/.test(l))) throw new Error('draco faces should carry vn indices');
      const preview = convertToObj(data, { collectObj: false, collectPreview: true }).preview;
      let worst = 0;
      for (let i = 0; i < preview.normals.length; i += 3) {
        const len = Math.hypot(preview.normals[i], preview.normals[i + 1], preview.normals[i + 2]);
        worst = Math.max(worst, Math.abs(len - 1));
      }
      if (worst > 1e-4) throw new Error('decoded draco normals not unit length (max error ' + worst + ') - quantization mishandled');
      const b = preview.bbox;
      if (!(b[3] > b[0] && b[4] > b[1] && b[5] > b[2])) throw new Error('draco bbox degenerate');
      console.log('draco OK: 34,834 verts / 69,451 faces decoded, normals unit length (err ' + worst.toExponential(1) + ')');
      setDracoModule(null);
    }
  }
}

// 18. Shipped fixtures: colors, point cloud, interleaved .gltf + sidecar
{
  const cube = path.join(here, 'fixtures', 'colored-cube.glb');
  if (fs.existsSync(cube)) {
    const { obj, stats } = convertToObj(fs.readFileSync(cube), { collectObj: true });
    const lines = obj.trim().split('\n');
    const count = (p) => lines.filter((l) => l.startsWith(p)).length;
    if (stats.points !== 24 || stats.faces !== 12 || stats.normals !== 24 || stats.colors !== 24) {
      throw new Error('cube stats wrong: ' + JSON.stringify(stats));
    }
    if (count('v ') !== 24 || count('vn ') !== 24 || count('vc ') !== 24 || count('f ') !== 12) throw new Error('cube line counts wrong');
    if (!lines.some((l) => /^f \d+\/\d+ \d+\/\d+ \d+\/\d+$/.test(l))) throw new Error('cube faces should be f v/vn');
    if (!lines.includes('vc 1 0 0')) throw new Error('cube missing red vertex color');
    const preview = convertToObj(fs.readFileSync(cube), { collectObj: false, collectPreview: true }).preview;
    if (!preview.colors || preview.colors[0] !== 1) throw new Error('cube preview colors missing');
    if (!preview.normals || preview.normalsGenerated) throw new Error('cube preview should use file normals');
    console.log('fixture colored-cube OK (v/vn/vc/f v-vn all present)');
  } else console.log('fixture colored-cube skipped');

  const cloud = path.join(here, 'fixtures', 'pointcloud.glb');
  if (fs.existsSync(cloud)) {
    const { obj, stats } = convertToObj(fs.readFileSync(cloud), { collectObj: true });
    if (stats.points !== 12000 || stats.faces !== 0) throw new Error('point cloud stats wrong: ' + JSON.stringify(stats));
    if (obj.includes('\nf ')) throw new Error('point cloud must not emit faces');
    if (stats.colors !== 12000) throw new Error('point cloud colors missing');
    const preview = convertToObj(fs.readFileSync(cloud), { collectObj: false, collectPreview: true }).preview;
    if (preview.normals !== null) throw new Error('point cloud has no faces so no normals should exist');
    if (preview.triCount !== 0) throw new Error('point cloud should have no triangles');
    if (Math.abs(preview.bbox[3] - 0.55) > 0.06) throw new Error('point cloud bbox wrong: ' + preview.bbox);
    console.log('fixture pointcloud OK (12k points, no faces, colors kept)');
  } else console.log('fixture pointcloud skipped');

  const gltfPath = path.join(here, 'fixtures', 'interleaved.gltf');
  if (fs.existsSync(gltfPath)) {
    const sidecars = new Map([['interleaved.bin', new Uint8Array(fs.readFileSync(path.join(here, 'fixtures', 'interleaved.bin')))]]);
    const { obj, stats } = convertToObj(fs.readFileSync(gltfPath, 'utf8'), { collectObj: true, sidecars });
    if (stats.points !== 4 || stats.faces !== 1) throw new Error('interleaved stats wrong: ' + JSON.stringify(stats));
    if (!obj.includes('v 0 0 0') || !obj.includes('v 2 0 0')) throw new Error('interleaved positions wrong (byteStride ignored?)');
    if (!obj.includes('vn 0 1 0')) throw new Error('interleaved normals wrong');
    if (!obj.includes('vc 1 0.50196078 0.25098039')) throw new Error('normalized uint8 colors wrong:\n' + obj.split('\n').filter((l) => l.startsWith('vc')).join('\n'));
    console.log('fixture interleaved .gltf + .bin OK (byteStride + normalized uint8 colors)');
  } else console.log('fixture interleaved skipped');
}

console.log('ALL TESTS PASSED');
