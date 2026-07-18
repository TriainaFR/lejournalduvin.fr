const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;
const HOST_CANONIQUE = 'www.lejournalduvin.fr';

// ————————————————————————————————————————————————————————————
// Liste blanche : seuls ces types de fichiers sont servis au public.
// Tout le reste — code serveur, notes de stratégie (.md), configs (.json),
// dotfiles (.claude/, .gitignore) — renvoie 404 comme s'il n'existait pas.
// Les .js ne sont servis que sous /assets/ (server.js et indexnow.js
// restent donc privés).
// ————————————————————————————————————————————————————————————
const PUBLIC_EXT = new Set([
  '.html', '.css', '.js', '.svg', '.ico', '.png', '.jpg', '.webp',
  '.xml', '.txt', '.woff2',
]);

function isPublic(filePath) {
  const rel = path.relative(ROOT, filePath);
  const segs = rel.split(path.sep);
  if (segs.some((s) => s.startsWith('.'))) return false; // dotfiles & dossiers cachés
  const ext = path.extname(filePath).toLowerCase();
  if (!PUBLIC_EXT.has(ext)) return false;                // .md, .json, .log…
  if (ext === '.js' && segs[0] !== 'assets') return false; // js hors /assets/ = code serveur
  return true;
}

// Types compressibles (le binaire — images, woff2 — est déjà compressé)
const COMPRESSIBLE = /^(text\/|application\/(javascript|json|xml)|image\/svg)/;
const MIN_COMPRESS_BYTES = 1024;

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

// Headers de sécurité posés sur TOUTES les réponses (pages, assets, 404,
// redirections) — indépendants de Cloudflare, qui ne proxifie pas www à ce jour.
const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' https://images.unsplash.com data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '),
};

const PAGE_404 = `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Page introuvable — Le Journal du Vin</title>
<link rel="stylesheet" href="/assets/fonts.css">
<style>body{background:#F4EEE0;color:#17110C;font-family:"Poppins","Helvetica Neue",Arial,sans-serif;font-weight:400;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center}
h1{font-family:"Fraunces",Georgia,serif;font-style:italic;font-weight:500;font-size:3rem;margin:0 0 .4rem}
p{color:#4A4038;margin:.3rem 0 1.8rem}
a{display:inline-block;border:1px solid #17110C;padding:.9rem 2.2rem;color:#17110C;text-decoration:none;font-size:.72rem;letter-spacing:.26em;text-transform:uppercase;font-weight:500;transition:.3s}
a:hover{background:#6B1F30;border-color:#6B1F30;color:#F4EEE0}</style></head>
<body><div><h1>Page introuvable</h1><p>Cette bouteille n’est pas — ou plus — dans notre cave.</p>
<a href="/">Retour à l’accueil</a></div></body></html>`;

function send(res, code, type, data, headers = {}) {
  res.writeHead(code, { 'Content-Type': type, ...SECURITY_HEADERS, ...headers });
  res.end(data);
}

function notFound(res) {
  send(res, 404, 'text/html; charset=utf-8', PAGE_404, { 'Cache-Control': 'no-cache' });
}

// Négocie le meilleur encodage supporté par le client : brotli > gzip > brut
function pickEncoding(req) {
  const accepted = (req.headers['accept-encoding'] || '').toLowerCase();
  if (/\bbr\b/.test(accepted)) return 'br';
  if (/\bgzip\b/.test(accepted)) return 'gzip';
  return null;
}

// Stratégie de cache :
// - .html et l'index de recherche : no-cache (doivent suivre chaque publication)
// - /assets/ (polices, favicons, CSS) : 1 an immutable — en cas de refonte d'un
//   asset, changer son nom de fichier (cache-busting)
// - robots.txt, sitemap.xml, llms.txt, clé IndexNow : 1 h
function cacheFor(filePath, ext) {
  const rel = path.relative(ROOT, filePath);
  if (ext === '.html') return 'no-cache';
  if (rel === path.join('assets', 'search-index.js')) return 'no-cache';
  if (rel.startsWith('assets' + path.sep)) return 'public, max-age=31536000, immutable';
  return 'public, max-age=3600';
}

function serveFile(req, res, filePath) {
  if (!isPublic(filePath)) return notFound(res);
  const ext = path.extname(filePath).toLowerCase();
  fs.readFile(filePath, (err, data) => {
    if (err) return notFound(res);

    const type = MIME[ext] || 'application/octet-stream';
    const headers = { 'Cache-Control': cacheFor(filePath, ext), Vary: 'Accept-Encoding' };

    const encoding = pickEncoding(req);
    if (!encoding || !COMPRESSIBLE.test(type) || data.length < MIN_COMPRESS_BYTES) {
      return send(res, 200, type, data, headers);
    }

    const compress = encoding === 'br'
      ? (buf, cb) => zlib.brotliCompress(buf, {
          params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 },
        }, cb)
      : (buf, cb) => zlib.gzip(buf, { level: 6 }, cb);

    compress(data, (zErr, compressed) => {
      // en cas d'échec de compression, on sert le contenu brut plutôt que d'échouer
      if (zErr) return send(res, 200, type, data, headers);
      send(res, 200, type, compressed, { ...headers, 'Content-Encoding': encoding });
    });
  });
}

http.createServer((req, res) => {
  // Filet de sécurité : si l'apex atteint Railway directement (changement DNS
  // futur), on le renvoie vers l'hôte canonique www. En temps normal ce chemin
  // n'est jamais exécuté : Cloudflare intercepte l'apex et redirige avant nous.
  // (Ne jamais rediriger www → apex ici : boucle infinie garantie.)
  const host = (req.headers.host || '').toLowerCase();
  if (host === 'lejournalduvin.fr') {
    return send(res, 301, 'text/plain', 'Redirection', {
      Location: 'https://' + HOST_CANONIQUE + req.url,
    });
  }

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
      return serveFile(req, res, path.join(filePath, 'index.html'));
    }
    if (!err) return serveFile(req, res, filePath);

    // URL propre sans extension : /recherche → recherche.html
    if (!path.extname(filePath)) {
      const alt = filePath.replace(/\/$/, '') + '.html';
      return fs.stat(alt, (err2) => {
        if (!err2) return serveFile(req, res, alt);
        notFound(res);
      });
    }
    notFound(res);
  });
}).listen(PORT, () => {
  console.log(`Le Journal du Vin — serveur démarré sur le port ${PORT}`);
  notifyIndexNowOnDeploy();
});

// ————————————————————————————————————————————————————————————
// IndexNow au déploiement (Railway uniquement, jamais en local) :
// on ne soumet que les URLs dont le <lastmod> du sitemap date d'aujourd'hui
// ou d'hier (UTC) — un déploiement purement cosmétique (CSS, typo) n'a pas
// de lastmod frais et ne notifie donc rien, conformément à la politique
// éditoriale du site.
// ————————————————————————————————————————————————————————————
function notifyIndexNowOnDeploy() {
  if (!process.env.RAILWAY_ENVIRONMENT_NAME && !process.env.RAILWAY_PROJECT_ID) return;
  setTimeout(() => {
    try {
      const xml = fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8');
      const entries = [...xml.matchAll(/<url>\s*<loc>\s*([^<]+?)\s*<\/loc>\s*<lastmod>\s*([^<]+?)\s*<\/lastmod>/g)];
      const day = (offset) => new Date(Date.now() - offset * 864e5).toISOString().slice(0, 10);
      const fresh = entries.filter((m) => m[2] === day(0) || m[2] === day(1)).map((m) => m[1]);
      if (!fresh.length) {
        console.log('IndexNow : aucun contenu frais dans le sitemap, pas de notification.');
        return;
      }
      const { submit } = require('./indexnow.js');
      console.log(`IndexNow : notification de ${fresh.length} URL(s) fraîche(s) après déploiement…`);
      submit(fresh);
    } catch (e) {
      console.error('IndexNow (déploiement) :', e.message);
    }
  }, 5000);
}
