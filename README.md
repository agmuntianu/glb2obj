# glb2obj

**One file: `glb2obj.html`. Double-click it.** Converts `.glb` / `.gltf` (point clouds and
triangle meshes) to `.obj`, entirely in the browser — no server, no upload, no install,
no dependencies.

```
open glb2obj.html          # or double-click it in Explorer
drop a .glb / .gltf        # converts immediately, shows a 3D preview, then Save .obj
```

Drag several files at once. A `.gltf` that references external buffers must be dropped
**together with** its `.bin` file(s).

## What it does

| Input | OBJ output |
| --- | --- |
| point-cloud primitives (POSITION, no indices) | `v` lines |
| indexed meshes | `v` + `f` lines (1-based, global index offset is correct across primitives) |
| `NORMAL` | `vn` lines in world space, faces written as `f v/vn` |
| `COLOR_0` | `vc` lines (Blender vertex-colour extension); untick *vertex colors* to skip |
| node hierarchy | full world transforms applied (translation / rotation / scale, cycles guarded) |
| all accessor types | int8/uint8/int16/uint16/uint32/float32, `normalized`, dense **and interleaved** (`byteStride`) |
| `KHR_draco_mesh_compression_ext` | decoded (Draco decoder is fetched once, see below) |

## Preview

WebGL, hand-written, no three.js. **Solid** (uses the model's normals; generates them for
preview when the file has none), **Wire** (edges decimated on dense meshes), **Points**
(adaptive sprite size, vertex colours preserved). Ground grid + RGB axes, fit to bounds.

* drag = orbit · wheel = zoom · right-drag / Shift-drag = pan
* `F` fit · `W` wire · `S` solid · `P` points

## Draco

Draco-compressed models need Google's WASM decoder, which is deliberately **not** inlined
(1.4 MB of base64 for a feature most files never use). On the first Draco model the page
loads `draco_decoder_gltf.js` + `.wasm` from `https://www.gstatic.com/draco/...`.

Offline: save `draco_decoder_gltf.js` and `draco_decoder_gltf.wasm` next to `glb2obj.html`,
or drop both onto the page, then retry.

## Deliberately not handled

Textures/UVs are dropped (a warning states how many primitives had UVs), morph targets are
dropped, skinning/bones export the bind pose, materials/`mtl` are not written, and no
axis flip is applied (glTF is Y-up; the OBJ comes out Y-up). The status line always tells
you what was left behind instead of failing silently.

## Limits

512 MB input, bounded memory: OBJ text is emitted in ≤1 MB chunks (never one giant
`join`), conversion runs as a generator time-sliced at ~24 ms/frame so the tab stays
responsive and cancellable on a 100 MB single-primitive mesh. Preview is capped and
decimated at 4 M vertices / 1.5 M triangles — the OBJ is never decimated.

## Development

```
node test.mjs                      # 21 checks, extracts the CORE block from the HTML
node dev/make-fixtures.mjs         # regenerates fixtures/ (cube, point cloud, interleaved)
node dev/make-draco-fixture.mjs    # regenerates fixtures/draco-bunny.glb (needs `npm i draco3dgltf`)
```

`test.mjs` is a dev harness only — the product has no dev dependencies. It is load-bearing:

* **Golden check**: output must be byte-identical to the pre-rewrite Node converter
  (commit `71d8866`, read out of git history) on the 5 MB real-world model.
* **Interleaved regression**: a `byteStride` test that fails if stride handling breaks.
* **Generator granularity**: asserts a single 100 k-point primitive still yields ≥10 times.
* **Draco**: real decoder decode of 34,834 verts / 69,451 faces, asserting decoded normals
  are unit length (catches quantization mishandling).

Anything inside `/* ==== CORE BEGIN ==== */ ... CORE END ==== */` must stay free of DOM and
Node APIs — that is what lets the same bytes run in the browser and under Node.
