#!/usr/bin/env node
/**
 * Le Journal du Vin — contrôle avant publication.
 *
 *   node validate.js          → contrôle tout, sort en 1 si erreur
 *   npm run check
 *
 * Sans dépendance, comme indexnow.js. Chaque règle correspond à une erreur
 * qui s'est réellement produite sur le site : elle est ici pour ne pas
 * revenir. Ajouter une règle plutôt que de compter sur la vigilance.
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const HOST = 'https://www.lejournalduvin.fr';

const errors = [];
const warnings = [];
const err = (file, msg) => errors.push({ file, msg });
const warn = (file, msg) => warnings.push({ file, msg });

/* ————— collecte des pages ————— */
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.html')) out.push(full);
  }
  return out;
}

const pages = walk(ROOT).map((full) => {
  const rel = path.relative(ROOT, full);
  const html = fs.readFileSync(full, 'utf8');
  const robots = (html.match(/name="robots" content="([^"]*)"/) || [])[1] || '';
  // /chemin/index.html → /chemin/ ; index.html → /
  let url = '/' + rel.replace(/\\/g, '/');
  url = url.endsWith('/index.html') ? url.slice(0, -10) : url;
  if (url === '/index.html') url = '/';
  return { rel, html, robots, url, noindex: /noindex/i.test(robots) };
});

/* ————— 1. JSON-LD : syntaxe ————— */
const ldOf = (page) => {
  const blocks = [];
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(page.html))) {
    try {
      blocks.push(JSON.parse(m[1]));
    } catch (e) {
      err(page.rel, `JSON-LD illisible : ${e.message}`);
    }
  }
  return blocks;
};
const nodesOf = (page) =>
  ldOf(page).flatMap((b) => (Array.isArray(b['@graph']) ? b['@graph'] : [b]));

/* ————— 2. Dates : ISO 8601 complet avec fuseau —————
   Google exige un datetime pour dateModified des Profile Pages, et le
   recommande partout ailleurs. Une date seule (« 2026-07-25 ») déclenche
   « Valeur de date et heure incorrecte » dans la Search Console.
   Erreur constatée le 26/07/2026 sur /auteur/camille-rousseau/. */
const ISO_FULL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:\d{2}|Z)$/;
const DATE_FIELDS = ['datePublished', 'dateModified', 'dateCreated', 'uploadDate'];

for (const page of pages) {
  const ld = {};

  for (const node of nodesOf(page)) {
    for (const field of DATE_FIELDS) {
      const value = node[field];
      if (value === undefined) continue;
      ld[field] = value;
      if (!ISO_FULL.test(value)) {
        err(page.rel, `${field} = "${value}" — attendu un ISO 8601 complet avec fuseau (2026-07-25T18:28:16+02:00)`);
      }
    }
    if (node.dateModified && node.datePublished && node.dateModified < node.datePublished) {
      err(page.rel, `dateModified (${node.dateModified}) antérieure à datePublished (${node.datePublished})`);
    }
  }

  // Open Graph : même exigence, et doit refléter le JSON-LD
  const og = {};
  for (const [prop, field] of [
    ['article:published_time', 'datePublished'],
    ['article:modified_time', 'dateModified'],
  ]) {
    const m = page.html.match(new RegExp(`<meta property="${prop}" content="([^"]*)"`));
    if (!m) continue;
    og[field] = m[1];
    if (!ISO_FULL.test(m[1])) {
      err(page.rel, `${prop} = "${m[1]}" — attendu un ISO 8601 complet avec fuseau`);
    }
    if (ld[field] && ld[field] !== m[1]) {
      err(page.rel, `${prop} (${m[1]}) ≠ ${field} du JSON-LD (${ld[field]})`);
    }
  }
}

/* ————— 3. Hôte canonique —————
   Cloudflare redirige l'apex vers www : une URL en apex dans le balisage
   envoie moteurs et IA sur une redirection. Piège récurrent des briefs. */
for (const page of pages) {
  const apex = page.html.match(/https:\/\/lejournalduvin\.fr[^\s"'<]*/g);
  if (apex) err(page.rel, `URL en apex (sans www) : ${[...new Set(apex)].slice(0, 3).join(', ')}`);

  if (!page.noindex) {
    const canonical = (page.html.match(/rel="canonical" href="([^"]*)"/) || [])[1];
    if (!canonical) err(page.rel, 'balise canonical absente');
    else if (canonical !== HOST + page.url) {
      err(page.rel, `canonical = "${canonical}" — attendu "${HOST + page.url}"`);
    }
  }
}

/* ————— 4. URL des pages auteur —————
   Le site utilise /auteur/<slug>/ au singulier ; les briefs proposent
   régulièrement /auteurs/, qui est un 404. */
for (const page of pages) {
  if (/\/auteurs\//.test(page.html)) err(page.rel, '/auteurs/ (pluriel) — le site utilise /auteur/<slug>/');
}

/* ————— 5. Crédits photo —————
   La rédaction ne possède aucune photo : tout est Wikimedia Commons ou
   Unsplash, crédité. « © Le Journal du Vin » est un faux crédit. */
for (const page of pages) {
  const captions = page.html.match(/<figcaption>([\s\S]*?)<\/figcaption>/g) || [];
  for (const c of captions) {
    if (/©\s*(le\s+)?journal\s+du\s+vin/i.test(c)) {
      err(page.rel, 'crédit photo « © Le Journal du Vin » — créditer la source réelle');
    }
    if (!/Photo\s/i.test(c) && !/Wikimedia|Unsplash/i.test(c)) {
      warn(page.rel, `légende sans crédit visible : ${c.replace(/<[^>]+>/g, '').trim().slice(0, 60)}…`);
    }
  }
}

/* ————— 6. Sitemap ————— */
const sitemapPath = path.join(ROOT, 'sitemap.xml');
if (!fs.existsSync(sitemapPath)) {
  err('sitemap.xml', 'fichier absent');
} else {
  const xml = fs.readFileSync(sitemapPath, 'utf8');
  const entries = [...xml.matchAll(/<loc>([^<]+)<\/loc>\s*<lastmod>([^<]+)<\/lastmod>/g)].map((m) => ({
    loc: m[1],
    lastmod: m[2],
  }));
  const locs = new Set(entries.map((e) => e.loc));

  for (const e of entries) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.lastmod) && !ISO_FULL.test(e.lastmod)) {
      err('sitemap.xml', `lastmod invalide pour ${e.loc} : "${e.lastmod}"`);
    }
    const page = pages.find((p) => HOST + p.url === e.loc);
    if (!page) err('sitemap.xml', `${e.loc} ne correspond à aucune page`);
    else if (page.noindex) err('sitemap.xml', `${e.loc} est en noindex et ne doit pas figurer au sitemap`);
  }

  for (const page of pages) {
    if (page.noindex) continue;
    if (!locs.has(HOST + page.url)) err('sitemap.xml', `${HOST + page.url} indexable mais absent du sitemap`);
  }
}

/* ————— 7. Assets locaux référencés ————— */
for (const page of pages) {
  const refs = new Set(page.html.match(/\/assets\/[A-Za-z0-9._\/-]+/g) || []);
  for (const ref of refs) {
    if (!fs.existsSync(path.join(ROOT, ref))) err(page.rel, `asset introuvable : ${ref}`);
  }
}

/* ————— 8. Une photo = un article —————
   Le 22/07/2026, une même photo illustrait trois articles avec trois
   légendes différentes. Les hubs et la home réutilisent légitimement
   l'image d'un article pour sa carte : seuls les articles sont comparés. */
const usage = new Map();
for (const page of pages) {
  const isArticle = nodesOf(page).some((n) => n['@type'] === 'Article');
  if (!isArticle) continue;
  for (const slug of new Set(
    (page.html.match(/\/assets\/img\/([a-z0-9-]+)-(?:480|800|1280)\.jpg/g) || []).map((s) =>
      s.replace(/-(?:480|800|1280)\.jpg$/, '').replace('/assets/img/', '')
    )
  )) {
    usage.set(slug, [...(usage.get(slug) || []), page.rel]);
  }
}
for (const [slug, used] of usage) {
  if (used.length > 1) err('assets/img', `${slug} utilisée par ${used.length} articles : ${used.join(', ')}`);
}

/* ————— rapport ————— */
const label = (n, s, p) => `${n} ${n > 1 ? p : s}`;
if (warnings.length) {
  console.log(`\n⚠  ${label(warnings.length, 'avertissement', 'avertissements')}\n`);
  for (const w of warnings) console.log(`   ${w.file}\n     ${w.msg}`);
}
if (errors.length) {
  console.log(`\n✗  ${label(errors.length, 'erreur', 'erreurs')}\n`);
  for (const e of errors) console.log(`   ${e.file}\n     ${e.msg}`);
  console.log('');
  process.exit(1);
}
console.log(`\n✓  ${pages.length} pages contrôlées — rien à signaler.\n`);
