/**
 * Le Journal du Vin — conversion HTML → Markdown pour les agents.
 *
 * Sert la négociation de contenu : un agent qui envoie `Accept: text/markdown`
 * reçoit l'article en markdown propre plutôt que 340 lignes de CSS suivies du
 * texte. Les navigateurs et Googlebot continuent de recevoir le HTML.
 *
 * Sans dépendance, comme indexnow.js et validate.js. Le convertisseur ne vise
 * pas le HTML arbitraire : il connaît le gabarit du site (art-head, content,
 * bottles, table-scroll, faq) et s'appuie dessus.
 */

const HOST = 'https://www.lejournalduvin.fr';

const ENTITES = {
  '&nbsp;': ' ', '&#8239;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>',
  '&quot;': '"', '&#39;': "'", '&eacute;': 'é', '&egrave;': 'è', '&agrave;': 'à',
  '&ccedil;': 'ç', '&ocirc;': 'ô', '&hellip;': '…', '&mdash;': '—', '&ndash;': '–',
};

function decode(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&[a-z]+;/gi, (e) => (e in ENTITES ? ENTITES[e] : e));
}

const sansBalises = (s) => decode(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

/** Contenu inline : liens, gras, italique, exposants. */
function inline(html) {
  let s = html
    .replace(/<sup>([\s\S]*?)<\/sup>/gi, '$1')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, txt) => {
      const t = sansBalises(txt);
      if (!t) return '';
      const url = href.startsWith('/') ? HOST + href : href;
      return `[${t}](${url})`;
    })
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, t) => {
      const v = sansBalises(t);
      return v ? `**${v}**` : '';
    })
    .replace(/<(em|i|cite)\b[^>]*>([\s\S]*?)<\/\2?>/gi, (m) => m)
    .replace(/<(em|i|cite)\b[^>]*>([\s\S]*?)<\/(?:em|i|cite)>/gi, (_, __, t) => {
      const v = sansBalises(t);
      return v ? `*${v}*` : '';
    });
  // Toute l'espace blanche est compressée, retours à la ligne compris : un
  // contenu inline qui garderait ses \n ferait déborder un titre markdown sur
  // plusieurs lignes (le <h1> de la home, indenté sur quatre lignes).
  return decode(s.replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    // Recoller la ponctuation : un fragment masqué aux lecteurs d'écran peut
    // commencer par une virgule, ce qui laisse « du Vin , le média ».
    .replace(/\s+([,.])/g, '$1')
    .trim();
}

// Titres : comme inline(), mais sans liens. Un « # » markdown contenant un
// lien se lit mal et casse l'ancrage ; le <h1> de la home enveloppe la marque
// dans un <a href="/">.
function titreInline(html) {
  return inline(html.replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, '$1'));
}

/** <table> → tableau markdown. */
function table(html) {
  const caption = (html.match(/<caption>([\s\S]*?)<\/caption>/i) || [])[1];
  const lignes = [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/gi)].map((m) =>
    [...m[1].matchAll(/<(th|td)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((c) => inline(c[2]).replace(/\|/g, '\\|'))
  ).filter((l) => l.length);
  if (!lignes.length) return '';
  const out = [];
  if (caption) out.push(`*${sansBalises(caption)}*`, '');
  out.push('| ' + lignes[0].join(' | ') + ' |');
  out.push('| ' + lignes[0].map(() => '---').join(' | ') + ' |');
  for (const l of lignes.slice(1)) out.push('| ' + l.join(' | ') + ' |');
  return out.join('\n');
}

/** <ul>/<ol> → liste markdown (les <li> du gabarit contiennent parfois un <h3>). */
function liste(html, ordonnee) {
  const items = [...html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => m[1]);
  return items
    .map((brut, i) => {
      const puce = ordonnee ? `${i + 1}.` : '-';
      const titre = (brut.match(/<h[34]\b[^>]*>([\s\S]*?)<\/h[34]>/i) || [])[1];
      if (titre) {
        // Fiche produit du gabarit : nom + prix + note, appellation, description.
        // Les trois se suivent sans séparateur en HTML : on les recompose.
        const prix = (titre.match(/<span class="prix">([\s\S]*?)<\/span>/i) || [])[1];
        const note = (titre.match(/<span class="note">([\s\S]*?)<\/span>/i) || [])[1];
        const nom = titreInline(titre.replace(/<span class="(?:prix|note)">[\s\S]*?<\/span>/gi, ''));
        const app = (brut.match(/<span class="app">([\s\S]*?)<\/span>/i) || [])[1];
        const meta = [prix, note, app].filter(Boolean).map(sansBalises).join(' · ');
        const corps = brut
          .replace(/<h[34]\b[^>]*>[\s\S]*?<\/h[34]>/i, '')
          .replace(/<span class="app">[\s\S]*?<\/span>/i, '');
        const desc = [...corps.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((p) => inline(p[1])).join(' ');
        return `${puce} **${nom}**${meta ? ` — ${meta}` : ''}${desc ? `\n  ${desc}` : ''}`;
      }
      return `${puce} ${inline(brut)}`;
    })
    .filter((l) => l.replace(/^[-\d.]+\s*/, '').trim())
    .join('\n');
}

/** Découpe un fragment en blocs de haut niveau et les convertit. */
function blocs(html) {
  const out = [];
  const re = /<(h2|h3|h4|p|ul|ol|table|blockquote|details|figcaption)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(html))) {
    const [, tag, attrs, corps] = m;
    switch (tag.toLowerCase()) {
      case 'h2': out.push('## ' + titreInline(corps)); break;
      case 'h3': out.push('### ' + titreInline(corps)); break;
      case 'h4': out.push('#### ' + titreInline(corps)); break;
      case 'p': {
        const t = inline(corps);
        if (t) out.push(/class="standfirst"/.test(attrs) ? `*${t}*` : t);
        break;
      }
      case 'ul': out.push(liste(corps, false)); break;
      case 'ol': out.push(liste(corps, true)); break;
      case 'table': out.push(table(m[0])); break;
      case 'blockquote': out.push('> ' + inline(corps)); break;
      case 'figcaption': out.push(`*${inline(corps)}*`); break;
      case 'details': {
        const q = (corps.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/i) || [])[1];
        const r = corps.replace(/<summary\b[^>]*>[\s\S]*?<\/summary>/i, '');
        if (q) out.push('### ' + titreInline(q));
        out.push(...blocs(r));
        break;
      }
    }
  }
  return out.filter(Boolean);
}

/** Convertit une page complète du site en markdown. */
function htmlToMarkdown(html, url) {
  const propre = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  const titre = (propre.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i) || [])[1];
  const description = (html.match(/<meta name="description" content="([^"]*)"/i) || [])[1];
  const main = (propre.match(/<main\b[^>]*>([\s\S]*)<\/main>/i) || [, propre])[1];

  // Zones à ignorer : sommaire (redondant en markdown), encadré auteur, boutons.
  const corps = main
    .replace(/<aside class="toc"[\s\S]*?<\/aside>/gi, '')
    .replace(/<div class="backrow"[\s\S]*?<\/div>/gi, '');

  const out = [];
  out.push('# ' + (titre ? titreInline(titre) : 'Le Journal du Vin'));
  out.push('');
  if (description) out.push('> ' + decode(description), '');

  const byline = (corps.match(/<p class="byline">([\s\S]*?)<\/p>/i) || [])[1];
  if (byline) out.push(sansBalises(byline).replace(/\s*◆\s*/g, ' · '), '');

  // Le chapô vit dans l'en-tête d'article, qu'on retire ensuite : on le sort ici.
  const chapo = (corps.match(/<p class="standfirst">([\s\S]*?)<\/p>/i) || [])[1];
  if (chapo) out.push('*' + inline(chapo) + '*', '');

  const apresEntete = corps.replace(/<header class="art-head">[\s\S]*?<\/header>/i, '');
  out.push(...blocs(apresEntete));

  out.push('', '---', '', `Source : ${url}`, 'Le Journal du Vin — média français indépendant sur le vin, le champagne et les spiritueux.');

  return out
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim() + '\n';
}

// Un agent demande-t-il explicitement du markdown ? Un Accept générique
// (astérisque/astérisque, ce qu'envoient beaucoup de robots) ne suffit pas :
// sinon Googlebot recevrait du markdown à la place du HTML.
function veutMarkdown(accept) {
  return typeof accept === 'string' && /(^|[\s,])text\/markdown\b/i.test(accept);
}

module.exports = { htmlToMarkdown, veutMarkdown };
