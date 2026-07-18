#!/usr/bin/env node
/* ————————————————————————————————————————————————————————————
   Le Journal du Vin — IndexNow
   Notifie Bing (et tout le réseau IndexNow : Yandex, Seznam…) qu'une
   ou plusieurs URLs ont été créées ou mises à jour, pour un recrawl
   quasi immédiat. Aucune dépendance.

   Clé publiée : https://www.lejournalduvin.fr/<KEY>.txt

   Usage :
     node indexnow.js                          → soumet toutes les URLs du sitemap.xml
     node indexnow.js https://…/a/ https://…/b/ → soumet uniquement les URLs indiquées
     npm run indexnow                          → idem (toutes les URLs du sitemap)

   À lancer APRÈS déploiement (Bing va chercher la clé sur le domaine
   public pour valider la propriété : le fichier-clé doit être en ligne).
———————————————————————————————————————————————————————————— */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const HOST = 'www.lejournalduvin.fr';
const KEY = 'd2dd380e50e10c1fcda26a4f92d9e82c';
const KEY_LOCATION = `https://${HOST}/${KEY}.txt`;
// Endpoint partagé du protocole : une soumission est relayée à tous les
// moteurs participants, Bing compris. (Alternative directe : https://www.bing.com/indexnow)
const ENDPOINT = 'https://api.indexnow.org/indexnow';

function urlsFromSitemap() {
  const xml = fs.readFileSync(path.join(__dirname, 'sitemap.xml'), 'utf8');
  return [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map(m => m[1]);
}

function submit(urlList) {
  const body = JSON.stringify({ host: HOST, key: KEY, keyLocation: KEY_LOCATION, urlList });
  const req = https.request(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
    },
  }, (res) => {
    let data = '';
    res.on('data', (d) => (data += d));
    res.on('end', () => {
      // 200 = accepté · 202 = reçu (validation en cours) · 403 = clé introuvable/invalide · 422 = URL hors domaine
      console.log(`IndexNow → HTTP ${res.statusCode}`);
      if (data.trim()) console.log(data.trim());
      if (res.statusCode >= 400) process.exitCode = 1;
    });
  });
  req.on('error', (e) => { console.error('Erreur IndexNow :', e.message); process.exitCode = 1; });
  req.write(body);
  req.end();
}

// Utilisable en CLI (node indexnow.js [urls…]) comme en module (require → submit)
module.exports = { submit, urlsFromSitemap };

if (require.main === module) {
  const args = process.argv.slice(2).filter((a) => /^https?:\/\//.test(a));
  const urls = args.length ? args : urlsFromSitemap();
  if (!urls.length) { console.error('Aucune URL à soumettre.'); process.exit(1); }
  console.log(`Soumission de ${urls.length} URL(s) à IndexNow…`);
  urls.forEach((u) => console.log('  • ' + u));
  submit(urls);
}
