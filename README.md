# glb2obj

Web app + CLI that converts `.glb` / `.gltf` 3D models (point clouds and triangle meshes) to `.obj`.

Zero dependencies — plain Node.js, no npm install needed.

## Features

- GLB and `.gltf` JSON input (embedded `data:` buffers; external buffer files via CLI)
- Point-cloud primitives → `v` lines; indexed meshes → `v` + `f` lines
- Normals (`NORMAL`) → `vn` lines in world space, faces as `f v/vn`
- Vertex colors (`COLOR_0`) → `vc` lines (Blender extension), toggleable
- Node hierarchy world transforms (translation / rotation / scale)
- glTF normalization rules for int8/uint8/int16/uint16 accessors
- Interleaved and dense accessors, all float/uint component types

## Files

| File | Purpose |
| --- | --- |
| `server.js` | HTTP server: serves UI, `POST /convert` (binds 127.0.0.1; `HOST`/`PORT` env) |
| `lib/glb2obj.js` | GLB/gltf parser + OBJ writer |
| `public/index.html` | Drag-and-drop UI (upload progress, colors toggle) |
| `test.js` | Synthetic + real GLB tests |
| `cli.js` | Command-line converter (batch mode) |
| `build/build.js` | SEA exe build script |

## CLI / GUI (exe)

```bash
glb2obj.exe              # GUI: starts local server, opens browser (drag & drop)
glb2obj.exe model.glb -o out.obj   # CLI: converts directly
glb2obj.exe a.glb b.gltf           # batch: each input -> <input>.obj
glb2obj.exe model.glb --no-colors  # skip vc lines
```

Drag & drop a `.glb`/`.gltf` onto the exe = CLI convert. Double-click / no args = GUI.

## CLI (node)

```bash
node cli.js model.glb [-o output.obj] [--no-colors]
```

## Standalone exe (Node SEA)

```bash
node build/build.js   # Node 25.5+ required
```

## API

```
POST /convert?name=<base-filename>[&colors=0]
Content-Type: application/octet-stream
body: raw GLB bytes (or .gltf JSON text)

200 → OBJ file (Content-Disposition: attachment)
    X-Stats: {"points":N,"faces":N,"normals":N,"colors":N,"objects":N,"skippedPrimitives":N,"ms":N}
400 → parse error message
```

Max upload size: 512 MB. Server binds to 127.0.0.1 by default (local tool); set `HOST=0.0.0.0` to expose on the network.

## Tests

```bash
node test.js
```
