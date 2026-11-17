// Each source returns { items: [{ thumb, full, fallback, title, credit, link }], more: bool }
const enc = encodeURIComponent;

// Keys built into the published site, so a shared link works without setup.
const DEFAULT_KEYS = {};

async function getJSON(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

const SOURCES = [
  {
    id: 'unsplash', name: 'Unsplash', needs: ['unsplash'],
    async search(q, page, k) {
      const d = await getJSON(`https://api.unsplash.com/search/photos?query=${enc(q)}&page=${page}&per_page=30&client_id=${enc(k.unsplash)}`);
      return {
        more: page < d.total_pages,
        items: d.results.map(p => ({
          thumb: p.urls.small,
          full: p.urls.raw + '&w=3840&q=85&fm=jpg',
          fallback: p.urls.regular,
          title: p.alt_description || p.description || 'Unsplash photo',
          credit: `${p.user.name} / Unsplash`,
          link: p.links.html,
        })),
      };
    },
  },
  {
    id: 'pexels', name: 'Pexels', needs: ['pexels'],
    async search(q, page, k) {
      const d = await getJSON(`https://api.pexels.com/v1/search?query=${enc(q)}&page=${page}&per_page=30`, { headers: { Authorization: k.pexels } });
      return {
        more: !!d.next_page,
        items: d.photos.map(p => ({
          thumb: p.src.medium,
          full: p.src.original + '?auto=compress&cs=tinysrgb&w=3840',
          fallback: p.src.large2x,
          title: p.alt || 'Pexels photo',
          credit: `${p.photographer} / Pexels`,
          link: p.url,
        })),
      };
    },
  },
  {
    id: 'pixabay', name: 'Pixabay', needs: ['pixabay'],
    async search(q, page, k) {
      const d = await getJSON(`https://pixabay.com/api/?key=${enc(k.pixabay)}&q=${enc(q.slice(0, 100))}&page=${page}&per_page=30&safesearch=true`);
      return {
        more: page * 30 < Math.min(d.totalHits, 500),
        items: d.hits.map(p => ({
          thumb: p.webformatURL,
          full: p.largeImageURL,
          fallback: p.webformatURL,
          title: p.tags || 'Pixabay image',
          credit: `${p.user} / Pixabay`,
          link: p.pageURL,
        })),
      };
    },
  },
  {
    id: 'openverse', name: 'Openverse', needs: [],
    async search(q, page) {
      const d = await getJSON(`https://api.openverse.org/v1/images/?q=${enc(q)}&page=${page}&page_size=20`);
      return {
        more: page < d.page_count,
        items: d.results.map(p => ({
          thumb: p.thumbnail,
          full: p.url,
          fallback: p.thumbnail,
          title: p.title || 'Openverse image',
          credit: [p.creator, p.source].filter(Boolean).join(' / '),
          link: p.foreign_landing_url,
        })),
      };
    },
  },
  {
    id: 'wikimedia', name: 'Wikimedia', needs: [],
    async search(q, page) {
      const d = await getJSON(`https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*&generator=search&gsrsearch=${enc(q + ' filetype:bitmap')}&gsrnamespace=6&gsrlimit=30&gsroffset=${(page - 1) * 30}&prop=imageinfo&iiprop=url|mime&iiurlwidth=1920`);
      const pages = Object.values(d.query?.pages || {}).sort((a, b) => a.index - b.index);
      return {
        more: !!d.continue,
        items: pages
          .map(p => ({ p, i: p.imageinfo?.[0] }))
          .filter(({ i }) => i && /jpeg|png|webp|gif/.test(i.mime))
          .map(({ p, i }) => ({
            thumb: i.thumburl.replace(/\/1920px-/, '/500px-'),
            full: i.thumburl,
            fallback: i.url,
            title: p.title.replace(/^File:/, '').replace(/\.\w+$/, ''),
            credit: 'Wikimedia Commons',
            link: i.descriptionurl,
          })),
      };
    },
  },
  {
    id: 'nasa', name: 'NASA', needs: [],
    async search(q, page) {
      const d = await getJSON(`https://images-api.nasa.gov/search?q=${enc(q)}&media_type=image&page=${page}&page_size=30`);
      const c = d.collection;
      return {
        more: !!c.links?.some(l => l.rel === 'next'),
        items: c.items.filter(p => p.links?.[0]?.href).map(p => {
          const t = p.links[0].href;
          return {
            thumb: t,
            full: t.replace(/~(thumb|small|medium)\./, '~orig.'),
            fallback: t.replace(/~(thumb|small)\./, '~medium.'),
            title: p.data[0].title,
            credit: 'NASA',
            link: `https://images.nasa.gov/details/${enc(p.data[0].nasa_id)}`,
          };
        }),
      };
    },
  },
];
