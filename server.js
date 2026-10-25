'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { convertGlbToObj, GlbError } = require('./lib/glb2obj');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1'; // local tool: loopback only; set HOST=0.0.0.0 to expose
const MAX_BODY = 512 * 1024 * 1024; // 512 MB

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('File too large (max 512 MB)'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Access-Control-Allow-Origin': '*', ...headers });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
      send(res, 200, html, { 'Content-Type': MIME['.html'] });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/convert') {
      const glb = await readBody(req, MAX_BODY);
      const started = Date.now();
      const { obj, stats } = convertGlbToObj(glb, {
        includeColors: url.searchParams.get('colors') !== '0',
      });
      const baseName = (url.searchParams.get('name') || 'model').replace(/[^\w-]/g, '_');
      send(res, 200, obj, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="${baseName}.obj"`,
        'X-Stats': JSON.stringify({ ...stats, ms: Date.now() - started }),
      });
      return;
    }

    send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
  } catch (err) {
    const status = err instanceof GlbError ? 400 : 500;
    send(res, status, err.message, { 'Content-Type': 'text/plain' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`glb2obj running at http://${HOST}:${PORT}`);
});
