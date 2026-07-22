#!/usr/bin/env node
/* ————————————————————————————————————————————————————————————
   Le Journal du Vin — IndexNow
   Notifie les moteurs qu'une ou plusieurs URLs ont été créées ou mises
   à jour, pour un recrawl quasi immédiat. Aucune dépendance.

   Deux endpoints sont appelés :
     • https://www.bing.com/indexnow   → Bing, donc Microsoft Copilot
       (Copilot n'a pas d'endpoint propre : il s'appuie sur l'index Bing,
        soumettre à Bing est LA façon de l'alimenter)
     • https://api.indexnow.org/indexnow → endpoint partagé du protocole,
       relayé aux autres moteurs participants (Yandex, Seznam, Naver…)

   Clé publiée : https://www.lejournalduvin.fr/<KEY>.txt

   Usage :
     npm run indexnow                            → toutes les URLs du sitemap
     node indexnow.js https://…/a/ https://…/b/  → uniquement ces URLs
     node indexnow.js --dry                      → n'envoie rien, liste seulement

   À lancer APRÈS déploiement : les moteurs vont chercher la clé sur le
   domaine public pour valider la propriété, le fichier-clé doit être en ligne.
———————————————————————————————————————————————————————————— */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const HOST = 'www.lejournalduvin.fr';
const KEY = 'd2dd380e50e10c1fcda26a4f92d9e82c';
const KEY_LOCATION = `https://${HOST}/${KEY}.txt`;

const ENDPOINTS = [
  { nom: 'Bing / Copilot', url: 'https://www.bing.com/indexnow' },
  { nom: 'Réseau IndexNow', url: 'https://api.indexnow.org/indexnow' },
];

// 200 = accepté · 202 = reçu, validation de la clé en cours
// 400 = requête invalide · 403 = clé introuvable ou invalide
// 422 = URL hors du domaine déclaré · 429 = trop de soumissions
const SENS = {
  200: 'accepté', 202: 'reçu, validation de la clé en cours',
  400: 'requête invalide', 403: 'clé introuvable ou invalide',
  422: 'URL hors domaine', 429: 'trop de soumissions',
};

function urlsFromSitemap() {
  const xml = fs.readFileSync(path.join(__dirname, 'sitemap.xml'), 'utf8');
  return [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((m) => m[1]);
}

function post(endpoint, urlList) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ host: HOST, key: KEY, keyLocation: KEY_LOCATION, urlList });
    const req = https.request(endpoint.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => resolve({ ...endpoint, code: res.statusCode, body: data.trim() }));
    });
    req.on('error', (e) => resolve({ ...endpoint, code: 0, err: e.message }));
    req.setTimeout(20000, () => { req.destroy(); resolve({ ...endpoint, code: 0, err: 'délai dépassé' }); });
    req.write(body);
    req.end();
  });
}

// Soumet la liste aux deux endpoints. Renvoie true si au moins un a accepté.
async function submit(urlList) {
  const res = await Promise.all(ENDPOINTS.map((e) => post(e, urlList)));
  let ok = false;
  for (const r of res) {
    if (r.code >= 200 && r.code < 300) ok = true;
    const etat = r.code === 0 ? 'échec réseau (' + r.err + ')' : `HTTP ${r.code} — ${SENS[r.code] || 'réponse inattendue'}`;
    console.log(`  ${r.code >= 200 && r.code < 300 ? '✓' : '✗'} ${r.nom.padEnd(16)} ${etat}`);
    if (r.body) console.log('      ' + r.body.slice(0, 200));
  }
  if (!ok) process.exitCode = 1;
  return ok;
}

module.exports = { submit, urlsFromSitemap };

if (require.main === module) {
  (async () => {
    const argv = process.argv.slice(2);
    const dry = argv.includes('--dry');
    const args = argv.filter((a) => /^https?:\/\//.test(a));
    const urls = args.length ? args : urlsFromSitemap();
    if (!urls.length) { console.error('Aucune URL à soumettre.'); process.exit(1); }

    console.log(`\nIndexNow — ${urls.length} URL(s)${args.length ? '' : ' (depuis sitemap.xml)'}`);
    urls.forEach((u) => console.log('  • ' + u.replace('https://www.lejournalduvin.fr', '')));
    console.log(`\nClé : ${KEY_LOCATION}`);

    if (dry) { console.log('\n(--dry : rien n’a été envoyé)\n'); return; }

    console.log('\nSoumission :');
    const ok = await submit(urls);
    console.log(ok
      ? '\nSoumis. Le recrawl intervient généralement sous quelques heures à quelques jours.\nSuivi : Bing Webmaster Tools → IndexNow.\n'
      : '\nAucun endpoint n’a accepté la soumission — vérifier que le fichier-clé répond bien en ligne.\n');
  })();
}
