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
   l'image d'un article pour sa carte : seuls les articles sont comparés.
   Les portraits d'auteur sont exclus — ils figurent par construction sur
   tous les articles signés par la même personne (JSON-LD Person.image). */
const usage = new Map();
for (const page of pages) {
  const isArticle = nodesOf(page).some((n) => n['@type'] === 'Article');
  if (!isArticle) continue;
  for (const slug of new Set(
    (page.html.match(/\/assets\/img\/([a-z0-9-]+)-(?:480|800|1280)\.jpg/g) || [])
      .map((s) => s.replace(/-(?:480|800|1280)\.jpg$/, '').replace('/assets/img/', ''))
      .filter((slug) => !slug.startsWith('portrait-'))
  )) {
    usage.set(slug, [...(usage.get(slug) || []), page.rel]);
  }
}
for (const [slug, used] of usage) {
  if (used.length > 1) err('assets/img', `${slug} utilisée par ${used.length} articles : ${used.join(', ')}`);
}

/* ————— 9. Pages indexables trop maigres —————
   Le 28/07/2026, la Search Console a classé /auteur/camille-rousseau/ en
   « Explorée, actuellement non indexée » : 332 mots, pour l'essentiel du
   texte que l'on retrouve ailleurs sur le site. Google indexe d'autant
   moins volontiers qu'une page apporte peu de contenu propre. Seuil
   d'alerte volontairement bas : il signale, il ne bloque pas. */
const SEUIL_MOTS = 350;
for (const page of pages) {
  if (page.noindex) continue;
  const texte = page.html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ');
  const n = texte.split(/\s+/).filter(Boolean).length;
  if (n < SEUIL_MOTS) {
    warn(page.rel, `${n} mots seulement — risque de « Explorée, actuellement non indexée » (seuil ${SEUIL_MOTS})`);
  }
}

/* ————— 10. Indexation : seules les vraies pages de contenu —————
   Règle posée par Lucas le 28/07/2026 : n'ouvrir à l'indexation que les
   articles et les vraies pages. Les pages de recherche, de résultats ou
   les hubs sans contenu n'ont rien à y faire.
   Le piège associé, constaté le même jour : /recherche portait un noindex
   ET un Disallow dans robots.txt. Un robots.txt qui interdit l'exploration
   empêche de lire le noindex — l'URL finit indexée sans contenu. Les deux
   sont exclusifs. */
const robotsPath = path.join(ROOT, 'robots.txt');
if (!fs.existsSync(robotsPath)) {
  err('robots.txt', 'fichier absent');
} else {
  const robots = fs.readFileSync(robotsPath, 'utf8');
  const disallows = [...robots.matchAll(/^\s*Disallow:\s*(\S+)\s*$/gim)]
    .map((m) => m[1])
    .filter((v) => v !== '/' && v.length > 1);

  for (const page of pages) {
    const bloque = disallows.some((d) => page.url.startsWith(d) || page.url === d + '/');
    if (bloque && page.noindex) {
      err(page.rel, `noindex ET bloquée par « Disallow: ${disallows.find((d) => page.url.startsWith(d))} » — le noindex ne sera jamais lu, retirer le Disallow`);
    }
    if (bloque && !page.noindex) {
      err(page.rel, 'bloquée par robots.txt mais sans noindex — elle peut être indexée sans contenu');
    }
  }

  // Routes utilitaires : jamais indexables
  for (const page of pages) {
    if (/^\/(recherche|search|tag|page|filtre)/.test(page.url) && !page.noindex) {
      err(page.rel, `${page.url} est une page utilitaire (recherche, filtre, pagination) : elle doit être en noindex`);
    }
  }

  // Un hub qui ne liste presque rien n'est pas une vraie page
  for (const page of pages) {
    if (page.noindex) continue;
    const cartes = (page.html.match(/class="card"/g) || []).length;
    const estHub = cartes > 0 || /class="hub-grid"/.test(page.html);
    if (estHub && cartes < 2) {
      warn(page.rel, `hub indexable ne listant que ${cartes} article(s) — passer en noindex jusqu'à ce qu'il en ait au moins 2`);
    }
  }
}

/* ————— 11. Négociation markdown —————
   Depuis le 28/07/2026, une requête `Accept: text/markdown` reçoit l'article
   en markdown (voir markdown.js). Le convertisseur s'appuie sur le gabarit du
   site : une page qui s'en écarte produirait un markdown vide ou truffé de
   balises, sans que rien ne le signale à la publication. */
const { htmlToMarkdown } = require('./markdown.js');
for (const page of pages) {
  if (page.noindex) continue;
  let md;
  try {
    md = htmlToMarkdown(page.html, HOST + page.url);
  } catch (e) {
    err(page.rel, `conversion markdown en échec : ${e.message}`);
    continue;
  }
  const mots = md.split(/\s+/).filter(Boolean).length;
  const balises = (md.match(/<[a-z\/][^>]*>/gi) || []).length;
  if (balises) err(page.rel, `markdown contenant ${balises} balise(s) HTML résiduelle(s)`);
  if (mots < 80) err(page.rel, `markdown quasi vide (${mots} mots) — le gabarit n’a pas été reconnu`);

  // Le titre du markdown doit être celui de la page. htmlToMarkdown retombe sur
  // un titre générique quand il ne trouve pas de <h1> : sans ce contrôle, une
  // page au gabarit cassé passerait inaperçue (et une page sans <h1> aussi).
  const h1 = (page.html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i) || [])[1];
  if (!h1) {
    err(page.rel, 'aucun <h1> — titre indispensable pour les moteurs comme pour la version markdown');
  } else {
    const attendu = h1.replace(/<[^>]+>/g, '').replace(/&#\d+;|&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 30);
    const obtenu = (md.match(/^# (.+)$/m) || [, ''])[1].replace(/\*/g, '').replace(/\s+/g, ' ').trim().slice(0, 30);
    if (attendu && obtenu.slice(0, 12) !== attendu.slice(0, 12)) {
      err(page.rel, `titre markdown « ${obtenu} » ≠ <h1> « ${attendu} » — gabarit non reconnu`);
    }
  }
}

/* ————— 12. ItemList sur les pages qui présentent une liste —————
   Constaté le 07/08/2026 : la home affichait neuf articles sans le moindre
   ItemList, et quatre pages listant des cuvées n'en avaient pas non plus.
   Une page qui énumère (sélection de bouteilles, grille d'articles, liste
   d'un auteur) doit le déclarer : c'est ce qui permet aux moteurs et aux
   moteurs de réponse de comprendre qu'il s'agit d'une liste, et non d'un
   texte suivi. On accepte l'ItemList à la racine du @graph ou imbriquée
   dans mainEntity / hasPart. */
// Les classes sont composées (« card reveal d2 », « card card--lead reveal ») :
// on cherche le mot dans l'attribut, jamais l'attribut entier. Une comparaison
// stricte sur class="card" laissait passer la home, dont toutes les cartes
// portent une classe d'animation en plus — c'est précisément le cas qui avait
// échappé au contrôle le 07/08/2026.
const compteClasse = (html, nom) =>
  (html.match(new RegExp(`class="[^"]*\\b${nom}\\b[^"]*"`, 'g')) || []).length;

const listeVisible = (page) => {
  // Deux gabarits d'article coexistent : ol.wines (les premiers guides) et
  // ul.bottles (depuis le guide champagne-30). Les deux énumèrent des cuvées.
  const bouteilles = compteClasse(page.html, 'bottles') + compteClasse(page.html, 'wines');
  const cartes = compteClasse(page.html, 'card') + compteClasse(page.html, 'feature');
  const articlesAuteur = (page.html.match(/<span class="t">/g) || []).length;
  if (bouteilles) return `sélection de bouteilles (${bouteilles} bloc.bottles)`;
  if (cartes >= 2) return `grille de ${cartes} articles`;
  if (articlesAuteur >= 2) return `liste de ${articlesAuteur} articles d'auteur`;
  return null;
};

for (const page of pages) {
  if (page.noindex) continue;
  const raison = listeVisible(page);
  if (!raison) continue;

  const noeuds = nodesOf(page);
  const aItemList = noeuds.some((n) => {
    if (n['@type'] === 'ItemList') return true;
    for (const clef of ['mainEntity', 'hasPart', 'about']) {
      const v = n[clef];
      if (v && typeof v === 'object' && v['@type'] === 'ItemList') return true;
    }
    return false;
  });
  if (!aItemList) {
    err(page.rel, `présente une ${raison} mais aucun ItemList dans le JSON-LD`);
    continue;
  }

  // numberOfItems doit correspondre au nombre réel d'entrées
  const listes = noeuds.flatMap((n) => {
    const out = n['@type'] === 'ItemList' ? [n] : [];
    for (const clef of ['mainEntity', 'hasPart', 'about']) {
      const v = n[clef];
      if (v && typeof v === 'object' && v['@type'] === 'ItemList') out.push(v);
    }
    return out;
  });
  for (const l of listes) {
    const reel = Array.isArray(l.itemListElement) ? l.itemListElement.length : 0;
    if (!reel) {
      err(page.rel, `ItemList « ${l['@id'] || l.name || 'sans @id'} » sans itemListElement`);
      continue;
    }
    if (l.numberOfItems !== undefined && l.numberOfItems !== reel) {
      err(page.rel, `ItemList « ${l['@id'] || l.name} » : numberOfItems = ${l.numberOfItems} pour ${reel} entrée(s)`);
    }
    const positions = l.itemListElement.map((e) => e && e.position);
    const attendues = positions.map((_, i) => i + 1);
    if (positions.join(',') !== attendues.join(',')) {
      err(page.rel, `ItemList « ${l['@id'] || l.name} » : positions non séquentielles (${positions.join(',')})`);
    }
  }
}

/* ————— 13. JSON-LD : clés dupliquées dans un même objet —————
   Écrit le 07/08/2026 après avoir introduit deux « mainEntity » sur le
   ProfilePage de Camille Rousseau. JSON.parse ne bronche pas : la dernière
   clé écrase silencieusement la première, et la relation déclarée disparaît
   sans qu'aucun contrôle ne le signale. On compare le nombre de clés
   présentes dans le texte source au nombre de clés réellement conservées
   après analyse : tout écart trahit un doublon. */
const compteClefsSource = (src) => {
  const compte = Object.create(null);
  // les clés d'objet JSON sont les chaînes suivies de « : »
  for (const m of src.matchAll(/"((?:[^"\\]|\\.)*)"\s*:/g)) {
    compte[m[1]] = (compte[m[1]] || 0) + 1;
  }
  return compte;
};
const compteClefsArbre = (valeur, compte = Object.create(null)) => {
  if (Array.isArray(valeur)) {
    for (const v of valeur) compteClefsArbre(v, compte);
  } else if (valeur && typeof valeur === 'object') {
    for (const [k, v] of Object.entries(valeur)) {
      compte[k] = (compte[k] || 0) + 1;
      compteClefsArbre(v, compte);
    }
  }
  return compte;
};

for (const page of pages) {
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(page.html))) {
    let arbre;
    try {
      arbre = JSON.parse(m[1]);
    } catch {
      continue; // déjà signalé par la règle 1
    }
    // On ne compte dans la source que les clés hors valeurs de chaîne :
    // on repart du JSON ré-encodé pour la comparaison, en neutralisant les
    // valeurs textuelles susceptibles de contenir « … » : …
    const source = m[1].replace(/:\s*"(?:[^"\\]|\\.)*"/g, ': ""');
    const src = compteClefsSource(source);
    const tree = compteClefsArbre(arbre);
    for (const [clef, n] of Object.entries(src)) {
      const garde = tree[clef] || 0;
      if (n > garde) {
        err(page.rel, `JSON-LD : clé « ${clef} » déclarée ${n} fois pour ${garde} conservée(s) — un doublon écrase silencieusement l'autre`);
      }
    }
  }
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
