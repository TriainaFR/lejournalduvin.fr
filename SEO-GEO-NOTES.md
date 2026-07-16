# Le Journal du Vin — Stratégie SEO & GEO (notes de recherche, juillet 2026)

Synthèse de la recherche menée pour la home page. À garder comme référence quand le site passera sur un vrai framework (Next.js ou autre) et que les rubriques seront créées.

## Architecture de catégories recommandée (silos)

1 répertoire = 1 pilier éditorial, profondeur max 3 niveaux, URLs en minuscules-sans-accents, un contenu = une seule URL canonique (les croisements se font par maillage interne, jamais par URLs dupliquées).

- `/vin/` — hub éditorial (vraie page mère avec contenu), sous-hubs par région : `/vin/bordeaux/`, `/vin/bourgogne/`, `/vin/loire/`, `/vin/rhone/`, `/vin/languedoc/`…
- `/champagne/` — pilier à part entière : `/champagne/maisons/`, `/champagne/vignerons/`, `/champagne/millesimes/`
- `/spiritueux/` — `/spiritueux/whisky/`, `/spiritueux/rhum/`, `/spiritueux/gin/`, `/spiritueux/cognac-armagnac/`
- `/cocktails/` — `/cocktails/recettes/` (schema Recipe), `/cocktails/techniques/`
- `/oenotourisme/` — visites de caves par région : `/oenotourisme/bourgogne/`, `/oenotourisme/champagne/`…
- `/guides/` — silo transversal des pages « money » : `/guides/prix/` (ex. `vin-moins-de-10-euros`), `/guides/occasions/` (ex. `vin-mariage`, `cadeau`), `/guides/accords-mets-vins/`, `/guides/millesimes/` (ex. `bordeaux-2019`)
- `/actualites/` — actu chaude, alimente un sitemap Google News
- Pages support : `/auteur/prenom-nom/`, `/a-propos/`, `/la-redaction/`, `/charte-editoriale/`, `/contact/`, `/recherche`
- Pages de tags : noindex au lancement. Pagination : pages auto-canoniques.

Maillage en cocon : hub → filles, filles → hub + entre sœurs ; les guides transversaux reçoivent des liens de chaque hub et de la home.

## Checklist SEO on-page (home)

- Title ≤ 60 car., mots-clés en tête ; meta description 150–160 car. riche en entités — **fait sur index.html**
- Un seul H1 définissant l'entité — **fait** (wordmark + suffixe sr-only)
- H2 = piliers de contenu, chaque section liée à son hub — **fait** (ancres provisoires)
- 80–150 mots de texte éditorial indexable — **fait** (manifeste ; idéalement à remonter plus haut dans le DOM à terme)
- Dates visibles sur les articles (signal fraîcheur) — **fait**
- Ancres descriptives, jamais « voir plus » nu — fait sauf « Tous les articles » (à affiner)
- JSON-LD @graph : NewsMediaOrganization + WebSite avec SearchAction, rendu côté serveur — **fait** (statique)
- Canonical auto-référent, lang="fr", OG/Twitter avec image 1200×630 — **fait**
- LCP ≤ 2,5 s (hero en fetchpriority=high, pas de lazy sur l'image LCP) — **fait** ; CLS ≤ 0,1 (aspect-ratio sur toutes les images) — **fait**
- À faire au passage en prod : noms de fichiers images descriptifs en français, WebP/AVIF auto-hébergés (remplacer les URLs Unsplash), robots.txt + sitemap XML (+ sitemap News), fil d'Ariane avec BreadcrumbList sur les pages intérieures, favicon .ico + apple-touch-icon
- Avertissement Loi Évin : s'il faut un bandeau d'âge, jamais en interstitiel bloquant (tue l'indexation et la récupération par les IA) — le bandeau discret dans le footer est déjà en place

## Checklist GEO (visibilité IA)

- robots.txt : **autoriser explicitement** GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-SearchBot, Claude-User, PerplexityBot, Perplexity-User, Google-Extended, Applebot-Extended ; vérifier que le CDN/WAF (Cloudflare) ne les bloque pas silencieusement
- Phrase de définition canonique, identique partout (home, /a-propos/, schema Organization) : « Le Journal du Vin est un média français indépendant qui déguste, compare et recommande vins, champagnes et spiritueux, et raconte les plus belles caves de France. » — **fait**
- Réponse d'abord (BLUF) : chaque guide ouvre par 2–3 phrases de réponse directe ; sections autonomes de 200–400 mots sous H2/H3 descriptifs
- Densité d'information > densité de mots-clés : entités nommées (appellations, domaines, cuvées, millésimes) + chiffres concrets (prix, notes, températures de service)
- Formats préférés des moteurs IA : classements numérotés, tableaux comparatifs, blocs avantages/inconvénients, FAQ (avec FAQPage schema)
- Pages dédiées aux requêtes conversationnelles : « quel vin pour un mariage ? », « quel champagne offrir à moins de 50 € ? », « que boire avec un plateau de fruits de mer ? »
- Fraîcheur : « Mis à jour le … » visible + dateModified ; rafraîchir les guides prix/millésimes à cadence fixe
- E-E-A-T : tout article signé, pages /auteur/ avec vraies références (sommelier, œnologue, WSET), schema Person + ProfilePage
- Corroboration off-site : nom + description cohérents sur tous les profils sociaux (sameAs), annuaires vin, à terme Wikidata
- Rendu 100 % côté serveur : les bots IA n'exécutent pas le JavaScript
- llms.txt : optionnel/expérimental, faible priorité
- Mesure : logs serveur (hits GPTBot/ClaudeBot/PerplexityBot), trafic référent chatgpt.com / perplexity.ai / gemini.google.com, panel mensuel de prompts test

## Schema sitewide (à implémenter avec les pages)

- Articles : NewsArticle (actu) / Article (evergreen) avec headline, image (3 recadrages 1×1, 4×3, 16×9), author (Person + url), datePublished, dateModified — rien de plus
- /auteur/ : ProfilePage + Person
- Hubs : CollectionPage + BreadcrumbList
- FAQ des guides : FAQPage · Cocktails : Recipe · Fiches bouteilles : Product + Review (avec parcimonie)
- Tout en JSON-LD server-side, @id stables croisés, validé Rich Results Test

## Design system (rappel)

- Palette : papier `#F4EEE0` · encre `#17110C` · bordeaux `#6B1F30` · or `#A9822F` / `#C8A96A`
- Typo : Bodoni Moda (titres, italique pour les têtes de section) + Jost (labels capitales espacées, UI)
- Signatures visuelles : arches de cave (univers), chips de catégorie chevauchant les photos, numéros romains or, interludes citation, section sombre œnotourisme
- Boutons carrés (border-radius 0), zoom photo lent au survol (1.2s), révélations au scroll
