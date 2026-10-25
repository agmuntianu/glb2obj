'use strict';

// CLI: glb2obj <input.glb|.gltf> [more inputs...] [-o output.obj] [--no-colors]
// Drag & drop a .glb onto the exe also works (path arrives as argv).
const fs = require('fs');
const path = require('path');
const { convertGlbToObj, GlbError } = require('./lib/glb2obj');

function usage() {
  console.log('Usage: glb2obj <input.glb|.gltf> [more inputs...] [-o output.obj] [--no-colors]');
  console.log('  Converts GLB/gltf 3D models (point cloud or mesh) to OBJ.');
  console.log('  -o output.obj   output file (single input only)');
  console.log('  --no-colors     skip vertex colors (vc lines)');
  console.log('  Default output: <input>.obj next to the input file.');
}

function runCli(argv) {
  const args = argv.slice();
  if (args.includes('-h') || args.includes('--help') || args.length === 0) {
    usage();
    process.exit(args.length === 0 ? 1 : 0);
  }

  const noColors = args.includes('--no-colors');
  if (noColors) args.splice(args.indexOf('--no-colors'), 1);

  let output;
  const oIdx = args.indexOf('-o');
  if (oIdx !== -1) {
    output = args[oIdx + 1];
    if (!output) { usage(); process.exit(1); }
    args.splice(oIdx, 2);
  }
  const inputs = args;
  if (output && inputs.length !== 1) {
    console.error('-o can only be used with a single input file');
    process.exit(1);
  }

  let failed = 0;
  for (const input of inputs) {
    const out = output || input.replace(/\.(glb|gltf)$/i, '') + '.obj';
    if (!fs.existsSync(input)) {
      console.error(`File not found: ${input}`);
      failed++;
      continue;
    }
    const t0 = Date.now();
    try {
      const buf = fs.readFileSync(input);
      const { obj, stats } = convertGlbToObj(buf, {
        basePath: path.dirname(path.resolve(input)),
        includeColors: !noColors,
      });
      fs.writeFileSync(out, obj);
      const mb = (fs.statSync(out).size / 1024 / 1024).toFixed(2);
      console.log(`OK: ${out} (${mb} MB)`);
      console.log(
        `  ${stats.points.toLocaleString()} vertices` +
        (stats.faces ? `, ${stats.faces.toLocaleString()} faces` : '') +
        (stats.normals ? `, ${stats.normals.toLocaleString()} normals` : '') +
        (stats.colors ? `, ${stats.colors.toLocaleString()} colors` : '') +
        ` in ${Date.now() - t0} ms`
      );
    } catch (err) {
      console.error(`ERROR: ${input}: ${err instanceof GlbError ? err.message : err.stack || err.message}`);
      failed++;
    }
  }
  if (failed) process.exit(1);
}

if (require.main === module) runCli(process.argv.slice(2));

module.exports = { runCli, usage };
