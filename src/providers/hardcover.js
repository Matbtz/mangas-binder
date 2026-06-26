import { getProviderConfig } from '../core/settings.js';

/**
 * Hardcover GraphQL metadata & triage provider.
 * Endpoint: https://api.hardcover.app/v1/graphql
 */

const ENDPOINT = 'https://api.hardcover.app/v1/graphql';

export const provider = {
  name: 'hardcover',
  label: 'Hardcover',
  capabilities: { download: false, metadata: true },

  async search(query) {
    const res = await graphqlQuery(SEARCH_QUERY, { query: `%${query}%` });
    const books = res?.data?.books || [];
    return books.map(b => ({
      id: String(b.id),
      title: b.title,
      year: b.release_year ?? null,
      cover: b.image?.url || null,
    }));
  },

  async getSeries(id) {
    const res = await graphqlQuery(GET_BOOK_QUERY, { id: Number(id) });
    const b = res?.data?.books_by_pk;
    if (!b) throw new Error(`Hardcover book ${id} not found`);
    const authors = (b.contributions || []).map(c => c.author?.name).filter(Boolean);
    return {
      title: b.title,
      authors: [...new Set(authors)],
      artists: [],
      genres: [],
      description: b.description || '',
      year: b.release_year ?? null,
      status: null,
      language: 'en',
    };
  },

  async listChapters() {
    return []; // Hardcover does not supply chapter/issue downloads
  },

  async getVolumeCovers() {
    return new Map();
  },

  /**
   * Triage media type (book, comic, manga) using Hardcover search + heuristic hints.
   * @returns {Promise<{ mediaType: 'book'|'comic'|'manga', id: string|null, title: string, description: string }>}
   */
  async classifyMedia(title, infoHints = {}) {
    let best = null;
    try {
      const clean = String(title).replace(/(\bvol|\btome|\bch|#)\.?\s*\d+.*/i, '').trim() || title;
      const res = await graphqlQuery(CLASSIFY_QUERY, { query: `%${clean}%` });
      const books = res?.data?.books || [];
      if (books.length > 0) best = books[0];
    } catch { /* if Hardcover search times out or fails, fall back to heuristic */ }

    const desc = (best?.description || '').toLowerCase();
    const slug = (best?.slug || '').toLowerCase();
    const bTitle = (best?.title || title).toLowerCase();
    const pub = (infoHints.publisher || '').toLowerCase();
    const genre = (infoHints.genre || '').toLowerCase();
    const mangaTag = String(infoHints.manga || '').toLowerCase();

    // 1. Explicit Manga tags or keywords
    if (mangaTag.includes('yes') || slug.includes('-manga') || desc.includes('manga') || desc.includes('shonen') || desc.includes('seinen')) {
      return { mediaType: 'manga', id: best ? String(best.id) : null, title: best?.title || title, description: best?.description || '' };
    }

    // 2. Explicit Comic publishers or keywords
    const comicPubs = ['dc comics', 'marvel', 'image', 'dark horse', 'idw', 'dynamite', 'boom', 'vertigo', '2000 ad', 'archie'];
    if (comicPubs.some(p => pub.includes(p)) || genre.includes('superhero') || desc.includes('dc comics') || desc.includes('marvel comics') || desc.includes('graphic novel')) {
      return { mediaType: 'comic', id: best ? String(best.id) : null, title: best?.title || title, description: best?.description || '' };
    }

    // 3. Western comic superhero keywords
    const comicHeroes = ['batman', 'spider-man', 'superman', 'x-men', 'wonder woman', 'green lantern', 'martian manhunter', 'avengers', 'justice league', 'iron man', 'flash', 'hulk', 'thor', 'captain america', 'daredevil', 'deadpool', 'wolverine', 'fantastic four', 'conan'];
    if (comicHeroes.some(h => bTitle.includes(h))) {
      return { mediaType: 'comic', id: best ? String(best.id) : null, title: best?.title || title, description: best?.description || '' };
    }

    // 4. If Hardcover returned a match that looks like a standard novel/non-fiction book (no manga/comic keywords)
    if (best) {
      const isComicOrManga = desc.includes('comic') || desc.includes('illustrated') || desc.includes('art') || bTitle.includes('vol') || bTitle.includes('tome');
      if (!isComicOrManga) {
        return { mediaType: 'book', id: String(best.id), title: best.title, description: best.description || '' };
      }
    }

    // Default fallback
    return { mediaType: infoHints.comicvineId ? 'comic' : 'manga', id: best ? String(best.id) : null, title: best?.title || title, description: best?.description || '' };
  },

  async testConnection() {
    const res = await graphqlQuery(CLASSIFY_QUERY, { query: '%batman%' });
    const books = res?.data?.books || [];
    return { message: `Reached Hardcover GraphQL, API key valid (${books.length} sample books returned).` };
  }
};

function getApiKey() {
  const cfg = getProviderConfig('hardcover') || {};
  const key = cfg.apikey || process.env.HARDCOVER_API_KEY;
  if (!key) throw new Error('Hardcover API key not set — configure HARDCOVER_API_KEY or add it in Settings → Sources');
  return String(key).replace(/^bearer\s+/i, '').trim();
}

async function graphqlQuery(query, variables = {}) {
  const token = getApiKey();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'mangas-binder/2.0 (+https://github.com/Matbtz/mangas-binder)'
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`Hardcover API error ${res.status}`);
    const data = await res.json();
    if (data.errors?.length) throw new Error(`Hardcover GraphQL: ${data.errors[0].message}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

const SEARCH_QUERY = `
query SearchBooks($query: String!) {
  books(where: { title: { _ilike: $query } }, limit: 10) {
    id
    title
    slug
    description
    release_date
  }
}
`;

const GET_BOOK_QUERY = `
query GetBook($id: Int!) {
  books_by_pk(id: $id) {
    id
    title
    description
    release_date
    contributions {
      author { name }
    }
  }
}
`;

const CLASSIFY_QUERY = `
query ClassifyBooks($query: String!) {
  books(where: { title: { _ilike: $query } }, limit: 5) {
    id
    title
    slug
    description
  }
}
`;
