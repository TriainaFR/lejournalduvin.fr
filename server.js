const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.webp': 'image/webp',
  '.xml':  'application/xml',
  '.txt':  'text/plain; charset=utf-8',
  '.woff2':'font/woff2',
};

const PAGE_404 = `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Page introuvable — Le Journal du Vin</title>
<link href="https://fonts.googleapis.com/css2?family=Bodoni+Moda:ital@1&family=Jost:wght@300;500&display=swap" rel="stylesheet">
<style>body{background:#F4EEE0;color:#17110C;font-family:Jost,sans-serif;font-weight:300;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center}
h1{font-family:"Bodoni Moda",serif;font-style:italic;font-weight:500;font-size:3rem;margin:0 0 .4rem}
p{color:#4A4038;margin:.3rem 0 1.8rem}
a{display:inline-block;border:1px solid #17110C;padding:.9rem 2.2rem;color:#17110C;text-decoration:none;font-size:.72rem;letter-spacing:.26em;text-transform:uppercase;font-weight:500;transition:.3s}
a:hover{background:#6B1F30;border-color:#6B1F30;color:#F4EEE0}</style></head>
<body><div><h1>Page introuvable</h1><p>Cette bouteille n’est pas — ou plus — dans notre cave.</p>
<a href="/">Retour à l’accueil</a></div></body></html>`;

function send(res, code, type, data, headers = {}) {
  res.writeHead(code, { 'Content-Type': type, ...headers });
  res.end(data);
}

function serveFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, 'text/html; charset=utf-8', PAGE_404);
    // .html et .js en no-cache : l’index de recherche doit suivre chaque publication
    const cache = (ext === '.html' || ext === '.js') ? 'no-cache' : 'public, max-age=3600';
    send(res, 200, MIME[ext] || 'application/octet-stream', data, { 'Cache-Control': cache });
  });
}

http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(req.url.split('?')[0]);
  } catch {
    return send(res, 400, 'text/plain', 'Bad request');
  }

  // garde anti-traversée de répertoire
  const safePath = path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, '');
  let filePath = path.join(ROOT, safePath);
  if (!filePath.startsWith(ROOT)) {
    return send(res, 403, 'text/plain', 'Forbidden');
  }

  fs.stat(filePath, (err, st) => {
    if (!err && st.isDirectory()) {
      // /dossier → /dossier/ (redirection canonique), puis index.html
      if (!urlPath.endsWith('/')) {
        const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
        return send(res, 301, 'text/plain', 'Redirection', { Location: urlPath + '/' + query });
      }
      return serveFile(res, path.join(filePath, 'index.html'));
    }
    if (!err) return serveFile(res, filePath);

    // URL propre sans extension : /recherche → recherche.html
    if (!path.extname(filePath)) {
      const alt = filePath.replace(/\/$/, '') + '.html';
      return fs.stat(alt, (err2) => {
        if (!err2) return serveFile(res, alt);
        send(res, 404, 'text/html; charset=utf-8', PAGE_404);
      });
    }
    send(res, 404, 'text/html; charset=utf-8', PAGE_404);
  });
}).listen(PORT, () => {
  console.log(`Le Journal du Vin — serveur démarré sur le port ${PORT}`);
});
