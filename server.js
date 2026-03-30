const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const stateHandler = require('./api/state');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function createApiResponse(res) {
  return {
    status(code) {
      return {
        json(payload) {
          sendJson(res, code, payload);
        },
      };
    },
  };
}

function safeJoin(base, target) {
  const targetPath = path.normalize(path.join(base, target));
  if (!targetPath.startsWith(base)) return null;
  return targetPath;
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);

  if (parsed.pathname === '/api/state') {
    try {
      if (req.method === 'POST') {
        let rawBody = '';
        req.on('data', (chunk) => {
          rawBody += chunk;
        });
        req.on('end', async () => {
          let body = {};
          try {
            body = rawBody ? JSON.parse(rawBody) : {};
          } catch (_) {
            sendJson(res, 400, { error: 'Invalid JSON body' });
            return;
          }

          try {
            await stateHandler({ method: req.method, query: parsed.query || {}, body }, createApiResponse(res));
          } catch (error) {
            sendJson(res, 500, { error: error.message || 'Unhandled server error' });
          }
        });
      } else {
        await stateHandler({ method: req.method, query: parsed.query || {}, body: {} }, createApiResponse(res));
      }
    } catch (error) {
      sendJson(res, 500, { error: error.message || 'Unhandled server error' });
    }
    return;
  }

  if (parsed.pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  let requested = parsed.pathname === '/' ? '/index.html' : parsed.pathname;
  const filePath = safeJoin(PUBLIC_DIR, requested);
  if (!filePath) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Server Error');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
