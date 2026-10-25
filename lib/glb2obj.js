'use strict';

// GLB / glTF -> OBJ converter. Zero dependencies.
//
// GLB layout (little-endian):
//   12-byte header: magic(0x46546C67 "glTF"), version, length
//   chunk 1: JSON (0x4E4F534A), padded with 0x20
//   chunk 2 (opt): BIN  (0x004E4942), padded with 0x00
//
// Output:
//   - Point-cloud primitives (no indices) -> v lines
//   - Indexed mesh primitives -> v + f lines (1-based indices)
//   - NORMAL attribute -> vn lines (world-space), faces as f v/vn
//   - COLOR_0 attribute -> vc lines (Blender vertex-color extension)
//   - Node hierarchy world transforms applied (translation/rotation/scale)

const fs = require('fs');
const path = require('path');

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

const COMPONENT = {
  5120: { size: 1, read: 'int8', norm: 'int8' },
  5121: { size: 1, read: 'uint8', norm: 'uint8' },
  5122: { size: 2, read: 'int16', norm: 'int16' },
  5123: { size: 2, read: 'uint16', norm: 'uint16' },
  5125: { size: 4, read: 'uint32' },
  5126: { size: 4, read: 'float32' },
};

class GlbError extends Error {}

/** Parse a GLB buffer into { gltf, bin }. */
function parseGlb(buf) {
  if (buf.byteLength < 20) throw new GlbError('File too small to be a GLB');
  const magic = buf.readUInt32LE(0);
  if (magic !== GLB_MAGIC) throw new GlbError('Not a GLB file (bad magic)');
  const version = buf.readUInt32LE(4);
  if (version !== 2) throw new GlbError(`Unsupported GLB container version ${version}`);
  const totalLength = buf.readUInt32LE(8);
  if (totalLength > buf.byteLength) throw new GlbError('Truncated GLB file');

  const gltf = { buffers: [] };
  let bin = null;
  let offset = 12;
  while (offset < totalLength) {
    const chunkLen = buf.readUInt32LE(offset);
    const chunkType = buf.readUInt32LE(offset + 4);
    const data = buf.subarray(offset + 8, offset + 8 + chunkLen);
    if (chunkType === CHUNK_JSON) {
      const json = JSON.parse(new TextDecoder('utf-8').decode(data));
      Object.assign(gltf, json);
    } else if (chunkType === CHUNK_BIN) {
      bin = data;
    }
    // 4-byte alignment: chunkLen is already padded to 4
    offset += 8 + chunkLen;
  }
  if (gltf.scene === undefined && !gltf.meshes && !gltf.nodes) throw new GlbError('GLB has no scene content');
  return { gltf, bin };
}

/** True if the input looks like glTF JSON (starts with '{' or '['). */
function isGltfJson(input) {
  if (typeof input === 'string') return input.trimStart().startsWith('{');
  for (let i = 0; i < Math.min(input.byteLength, 64); i++) {
    const b = input[i];
    if (b === 0x7b || b === 0x5b) return true; // '{' or '['
    if (b > 0x20 && b < 0x7f) return false;    // non-ASCII printable: not JSON
  }
  return false;
}

/**
 * Build a resolver for buffer data. GLB: embedded BIN chunk. glTF: data: URIs
 * and (when basePath is given) external buffer files relative to basePath.
 */
function makeBufferResolver(gltf, bin, basePath) {
  const cache = new Map();
  return (bufferIndex) => {
    if (cache.has(bufferIndex)) return cache.get(bufferIndex);
    const buffer = gltf.buffers[bufferIndex];
    if (!buffer) throw new GlbError('Missing buffer definition');
    let data;
    if (buffer.uri === undefined) {
      if (!bin) throw new GlbError('Buffer without uri but no BIN chunk present');
      data = bin;
    } else if (buffer.uri.startsWith('data:')) {
      data = Buffer.from(buffer.uri.split(',')[1], 'base64');
    } else if (basePath) {
      const p = path.resolve(basePath, buffer.uri);
      try {
        data = fs.readFileSync(p);
      } catch (e) {
        throw new GlbError(`Cannot read external buffer "${buffer.uri}" (${e.code || e.message})`);
      }
    } else {
      throw new GlbError(`External buffer "${buffer.uri}" not supported (use embedded data, or the CLI on a .gltf file)`);
    }
    cache.set(bufferIndex, data);
    return data;
  };
}

/** Resolve a bufferView to a Uint8Array view over the buffer data. */
function getViewData(gltf, getBuffer, bvIndex) {
  const bv = gltf.bufferViews[bvIndex];
  if (!bv) throw new GlbError('Missing bufferView');
  const data = getBuffer(bv.buffer);
  const byteOffset = bv.byteOffset || 0;
  const end = byteOffset + (bv.byteLength || 0);
  if (end > data.byteLength) throw new GlbError(`bufferView ${bvIndex} out of bounds (needs ${end} bytes, buffer has ${data.byteLength})`);
  return new Uint8Array(data.buffer, data.byteOffset + byteOffset, bv.byteLength);
}

/** Read an accessor as a flat array of numbers, applying glTF normalization. */
function readAccessor(gltf, getBuffer, accessorIndex) {
  const acc = gltf.accessors[accessorIndex];
  if (!acc) throw new GlbError('Missing accessor');
  const comp = COMPONENT[acc.componentType];
  if (!comp) throw new GlbError(`Unsupported componentType ${acc.componentType}`);
  const bv = getViewData(gltf, getBuffer, acc.bufferView);
  const byteOffset = (acc.byteOffset || 0);
  const numComponents = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 }[acc.type];
  if (!numComponents) throw new GlbError(`Unsupported accessor type ${acc.type}`);
  const stride = bv.bytesPerElement || comp.size * numComponents; // interleaved vs dense
  const view = new DataView(bv.buffer, bv.byteOffset, bv.byteLength);
  const out = new Float64Array(acc.count * numComponents);
  for (let i = 0; i < acc.count; i++) {
    const base = byteOffset + i * stride;
    for (let c = 0; c < numComponents; c++) {
      const off = base + c * comp.size;
      let v;
      switch (comp.read) {
        case 'int8': v = view.getInt8(off); break;
        case 'uint8': v = view.getUint8(off); break;
        case 'int16': v = view.getInt16(off, true); break;
        case 'uint16': v = view.getUint16(off, true); break;
        case 'uint32': v = view.getUint32(off, true); break;
        case 'float32': v = view.getFloat32(off, true); break;
      }
      if (acc.normalized) {
        switch (comp.norm) {
          case 'int8': v = (v + 128) / 128 - 1; break;   // -1..1
          case 'int16': v = v / 32768; break;            // -1..1
          case 'uint8': v = v / 255; break;              // 0..1
          case 'uint16': v = v / 65535; break;          // 0..1
          default: break;
        }
      }
      out[i * numComponents + c] = v;
    }
  }
  return out;
}

// ---- 4x4 matrix helpers (column-major, glTF convention) ----

function matTRS(translation, rotation, scale) {
  const [tx, ty, tz] = translation || [0, 0, 0];
  const [sx, sy, sz] = scale || [1, 1, 1];
  const [x, y, z, w] = rotation || [0, 0, 0, 1];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, yy = y * y2, zz = z * z2;
  const xy = x * y2, xz = x * z2, yz = y * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

function matMul(a, b) {
  const out = new Array(16).fill(0);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] =
        a[row] * b[col * 4] + a[4 + row] * b[col * 4 + 1] +
        a[8 + row] * b[col * 4 + 2] + a[12 + row] * b[col * 4 + 3];
    }
  }
  return out;
}

/** 3x3 normal matrix (inverse-transpose of the 3x3 part) as column-major array. */
function normalMatrix(m) {
  const a = m[0], d = m[1], g = m[2], b = m[4], e = m[5], h = m[6], c = m[8], f = m[9], i = m[10];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-30) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const inv = 1 / det;
  return [
    (e * i - f * h) * inv, (c * h - b * i) * inv, (b * f - c * e) * inv,
    (e * g - d * h) * inv, (a * i - a * g) * inv, (c * d - a * f) * inv,
    (d * h - e * g) * inv, (c * g - b * h) * inv, (a * e - b * d) * inv,
  ];
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** World matrices for every node, accounting for the node hierarchy. */
function nodeWorldMatrices(gltf) {
  const nodes = gltf.nodes || [];
  const world = new Array(nodes.length);
  function walk(index, parent) {
    const node = nodes[index];
    const local = node
      ? matTRS(node.translation, node.rotation, node.scale)
      : IDENTITY;
    world[index] = matMul(parent, local);
    (node && node.children || []).forEach((c) => walk(c, world[index]));
  }
  let root = gltf.scene !== undefined ? (gltf.scenes[gltf.scene]?.nodes || []) : [];
  if (!root.length) root = nodes.map((_, i) => i); // scene missing/empty: use all nodes
  root.forEach((i) => walk(i, IDENTITY));
  return world;
}

function fmtNum(v) {
  if (Math.abs(v) < 1e-9) return '0';
  return String(Number(v.toPrecision(8)));
}

/**
 * Convert GLB bytes (or .gltf JSON text) to OBJ.
 * @param {Uint8Array|Buffer|string} input GLB bytes or glTF JSON
 * @param {object} [options]
 * @param {string} [options.basePath] directory for external .gltf buffer files
 * @param {boolean} [options.includeColors=true] emit COLOR_0 as vc lines
 * @returns {{obj: string, stats: object}}
 */
function convertGlbToObj(input, options) {
  const opts = options || {};
  const includeColors = opts.includeColors !== false;

  let gltf, bin = null;
  if (isGltfJson(input)) {
    gltf = JSON.parse(typeof input === 'string' ? input : input.toString('utf8'));
  } else {
    ({ gltf, bin } = parseGlb(input));
  }
  const getBuffer = makeBufferResolver(gltf, bin, opts.basePath);
  const world = nodeWorldMatrices(gltf);

  const lines = ['# Converted from GLB by glb2obj'];
  let totalPoints = 0;
  let totalFaces = 0;
  let totalNormals = 0;
  let totalColors = 0;
  let skippedPrimitives = 0;
  let objects = 0;

  const nodes = gltf.nodes || [];
  for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex++) {
    const node = nodes[nodeIndex];
    if (node.mesh === undefined) continue;
    const mesh = gltf.meshes[node.mesh];
    if (!mesh) continue;
    const name = (node.name || mesh.name || `object_${nodeIndex}`).replace(/[^\w.-]/g, '_');

    lines.push(`o ${name}`);
    objects++;

    const m = world[nodeIndex] || IDENTITY;
    const n = normalMatrix(m);
    // hoisted for the hot loop
    const m0 = m[0], m1 = m[1], m2 = m[2], m4 = m[4], m5 = m[5], m6 = m[6],
          m8 = m[8], m9 = m[9], m10 = m[10], m12 = m[12], m13 = m[13], m14 = m[14];
    const n0 = n[0], n1 = n[1], n2 = n[2], n3 = n[3], n4 = n[4],
          n5 = n[5], n6 = n[6], n7 = n[7], n8 = n[8];

    for (let primIndex = 0; primIndex < mesh.primitives.length; primIndex++) {
      const primitive = mesh.primitives[primIndex];
      const posAttr = primitive.attributes ? primitive.attributes.POSITION : undefined;
      if (posAttr === undefined) { skippedPrimitives++; continue; }

      const positions = readAccessor(gltf, getBuffer, posAttr);
      const count = positions.length / 3;
      const primVertBase = totalPoints;   // verts written before this primitive
      const primNormalBase = totalNormals;

      const hasNormals = primitive.attributes && primitive.attributes.NORMAL !== undefined;
      const normals = hasNormals ? readAccessor(gltf, getBuffer, primitive.attributes.NORMAL) : null;
      const colorAttr = includeColors && primitive.attributes ? primitive.attributes.COLOR_0 : undefined;
      const colors = colorAttr !== undefined ? readAccessor(gltf, getBuffer, colorAttr) : null;
      const colorComponents = colors ? colors.length / count : 0;

      lines.push(`g ${name}_p${primIndex + 1}`);

      for (let i = 0; i < count; i++) {
        const o3 = i * 3;
        const px = positions[o3], py = positions[o3 + 1], pz = positions[o3 + 2];
        lines.push(
          'v ' + fmtNum(m0 * px + m4 * py + m8 * pz + m12) + ' ' +
          fmtNum(m1 * px + m5 * py + m9 * pz + m13) + ' ' +
          fmtNum(m2 * px + m6 * py + m10 * pz + m14)
        );
        if (hasNormals) {
          lines.push(
            'vn ' + fmtNum(n0 * normals[o3] + n3 * normals[o3 + 1] + n6 * normals[o3 + 2]) + ' ' +
            fmtNum(n1 * normals[o3] + n4 * normals[o3 + 1] + n7 * normals[o3 + 2]) + ' ' +
            fmtNum(n2 * normals[o3] + n5 * normals[o3 + 1] + n8 * normals[o3 + 2])
          );
          totalNormals++;
        }
        if (colors) {
          const oc = i * colorComponents;
          let vc = 'vc';
          for (let c = 0; c < colorComponents; c++) {
            vc += ' ' + fmtNum(Math.max(0, Math.min(1, colors[oc + c])));
          }
          lines.push(vc);
          totalColors++;
        }
        totalPoints++;
      }

      // indexed mesh -> write faces (point clouds have no indices)
      if (primitive.indices !== undefined) {
        const idx = readAccessor(gltf, getBuffer, primitive.indices);
        // OBJ indices are global: offset by verts written before this primitive
        const vOff = primVertBase + 1;
        const nOff = primNormalBase + 1 - vOff;
        for (let i = 0; i + 2 < idx.length; i += 3) {
          const a = idx[i] + vOff, b = idx[i + 1] + vOff, c = idx[i + 2] + vOff;
          if (hasNormals) {
            lines.push(`f ${a}/${a + nOff} ${b}/${b + nOff} ${c}/${c + nOff}`);
          } else {
            lines.push(`f ${a} ${b} ${c}`);
          }
          totalFaces++;
        }
      }
    }
  }

  if (totalPoints === 0) {
    throw new GlbError('No geometry found (need meshes with POSITION attribute)');
  }

  return {
    obj: lines.join('\n') + '\n',
    stats: {
      points: totalPoints,
      faces: totalFaces,
      normals: totalNormals,
      colors: totalColors,
      objects,
      skippedPrimitives,
    },
  };
}

module.exports = { convertGlbToObj, GlbError };
