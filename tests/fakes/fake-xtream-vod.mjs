// Synthetic Xtream player_api responses for movies and series (Stage 6). Shapes follow the
// documented Xtream Codes API and the variations panels are known to send (numbers vs numeric
// strings, null vs "", episodes keyed by season or sent as arrays). No real provider data.
import { readFileSync } from 'node:fs';

const xt = (name) => readFileSync(new URL('../fixtures/xtream/' + name, import.meta.url), 'utf8');

export const VOD_CATEGORIES = [
  { category_id: '10', category_name: 'Action', parent_id: 0 },
  { category_id: 11, category_name: 'Comédie – Français', parent_id: '0' },
  { category_id: '12', category_name: 'أفلام عربية', parent_id: 0 },
  { category_id: '13', category_name: 'XXX | Adults' },
  { category_name: 'no id' },
  'garbage'
];

export const MOVIES = [
  { num: 1, name: 'The Long Night (2019)', stream_type: 'movie', stream_id: 5001, stream_icon: 'http://img.example.org/posters/5001.jpg', rating: '7.4', rating_5based: 3.7, added: '1700000000', category_id: '10', container_extension: 'mkv' },
  { num: '2', name: 'Amélie ✨ 🇫🇷', stream_type: 'movie', stream_id: '5002', stream_icon: '', rating: '', rating_5based: 4.2, added: 1700000500, category_id: 11, container_extension: 'MP4' },
  { num: 3, name: 'فيلم عربي', stream_id: 5003, stream_icon: 'javascript:alert(1)', rating: null, category_id: '12', container_extension: 'avi' },
  { num: 4, name: 'No Category', stream_id: 5004, category_id: null },
  { num: 5, name: 'Lost Category', stream_id: 5005, category_id: '999', container_extension: 'mp4' },
  { num: 6, name: 'Adult title', stream_id: 5006, category_id: '13', is_adult: '1' },
  { num: 7, name: '', stream_id: 5007, category_id: '10' },
  { num: 8, name: 'Bad id', stream_id: 'a b', category_id: '10' },
  { num: 9, name: 'Duplicate', stream_id: 5001, category_id: '10' },
  null
];

export const SERIES_CATEGORIES = [
  { category_id: '20', category_name: 'Drama' },
  { category_id: '21', category_name: 'Kids 🧸' }
];

export const SERIES = [
  { num: 1, name: 'City Lights', series_id: 7001, cover: 'http://img.example.org/covers/7001.jpg', plot: 'A city.', genre: 'Drama, Crime', releaseDate: '2018-03-01', last_modified: '1700000000', rating: '8.1', category_id: '20' },
  { num: 2, name: 'Bébé & Co 🧸', series_id: '7002', cover: null, genre: '', releaseDate: null, rating: 0, category_id: 21 },
  { num: 3, name: 'Array Seasons', series_id: 7003, category_id: '20' },
  { num: 4, name: 'Empty Show', series_id: 7004, category_id: '20' },
  { num: 5, name: 'Bad Info', series_id: 7005, category_id: '20' },
  { name: 'no id', category_id: '20' }
];

export const VOD_INFO = {
  5001: { info: { name: 'The Long Night', plot: 'A long night in a small town – “with Unicode”.', genre: 'Thriller', director: 'A. Director', cast: 'One, Two', releasedate: '2019-10-01', duration_secs: 6300, duration: '01:45:00', rating: '7.4', movie_image: 'http://img.example.org/big/5001.jpg', backdrop_path: ['http://img.example.org/bd/5001.jpg'] }, movie_data: { stream_id: 5001, name: 'The Long Night', container_extension: 'mkv' } },
  5002: { info: { description: 'Une fille à Paris.', genre: 'Comédie', duration: '02:02:00' }, movie_data: { stream_id: 5002, container_extension: 'mp4' } },
  5003: { info: [], movie_data: {} },
  5004: 'not an object'
};

export const SERIES_INFO = {
  7001: {
    seasons: [{ season_number: 1, name: 'Season One', cover: 'http://img.example.org/s/1.jpg' }, { season_number: 2, name: 'Season Two' }, { season_number: 9, name: 'No episodes' }],
    info: { name: 'City Lights', plot: 'Crime in a city.', genre: 'Drama', director: 'D', cast: 'C', releaseDate: '2018-03-01', rating: '8.1', cover: 'http://img.example.org/covers/7001.jpg' },
    episodes: {
      2: [{ id: '9201', episode_num: 1, title: 'S2 E1 – Début', container_extension: 'mkv', season: 2, info: { duration_secs: 2700, plot: 'Second season starts.' } }],
      1: [
        { id: 9102, episode_num: '2', title: 'Second', container_extension: 'mp4', season: '1', info: { duration: '00:44:00' } },
        { id: 9101, episode_num: 1, title: 'Pilot 🎬', container_extension: 'mp4', season: 1, info: { duration_secs: '2640', plot: 'It begins.', movie_image: 'http://img.example.org/ep/9101.jpg' } },
        { id: 'bad id', episode_num: 3, title: 'Broken' },
        { episode_num: 4, title: 'No id' }
      ]
    }
  },
  7002: { info: { name: 'Bébé & Co 🧸' }, seasons: [], episodes: { 1: [{ id: 9301, title: '', container_extension: 'mp4' }] } },
  7003: { info: {}, episodes: [[{ id: 9401, episode_num: 1, season: 1, title: 'A1' }], [{ id: 9402, episode_num: 1, season: 2, title: 'B1' }]] },
  7004: { info: { plot: 'Nothing yet.' }, seasons: [], episodes: [] },
  7005: [1, 2, 3]
};

/** A player_api.php route for the fake HTTP server. `over` replaces any action's response. */
export function xtreamVodRoute(over = {}) {
  const calls = [];
  const fn = (url) => {
    const a = (/[?&]action=([a-z_]+)/.exec(url) || [])[1] || '';
    calls.push(a);
    if (over[a]) return over[a](url);
    if (a === '') return { status: 200, body: xt('auth-ok.json') };
    if (a === 'get_live_categories') return { status: 200, body: xt('live-categories.json') };
    if (a === 'get_live_streams') return { status: 200, body: xt('live-streams.json') };
    if (a === 'get_vod_categories') return { status: 200, body: JSON.stringify(VOD_CATEGORIES) };
    if (a === 'get_vod_streams') return { status: 200, body: JSON.stringify(MOVIES), chunk: 97 };
    if (a === 'get_series_categories') return { status: 200, body: JSON.stringify(SERIES_CATEGORIES) };
    if (a === 'get_series') return { status: 200, body: JSON.stringify(SERIES), chunk: 61 };
    if (a === 'get_vod_info') {
      const id = (/[?&]vod_id=([^&]+)/.exec(url) || [])[1];
      return id in VOD_INFO ? { status: 200, body: JSON.stringify(VOD_INFO[id]) } : { status: 200, body: '{}' };
    }
    if (a === 'get_series_info') {
      const id = (/[?&]series_id=([^&]+)/.exec(url) || [])[1];
      return id in SERIES_INFO ? { status: 200, body: JSON.stringify(SERIES_INFO[id]) } : { status: 200, body: '{}' };
    }
    return { status: 200, body: '[]' };
  };
  return { fn, calls };
}

/** n synthetic movies in `cats` categories (large-catalogue tests). */
export function manyMovies(n, cats) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ num: i + 1, name: 'Movie ' + i + (i % 7 === 0 ? ' – é 🎬' : ''), stream_type: 'movie', stream_id: 100000 + i,
      stream_icon: 'http://img.example.org/p/' + (i % 1000) + '/' + i + '.jpg', rating: String((i % 100) / 10), added: String(1700000000 + i),
      category_id: String(i % cats), container_extension: i % 2 ? 'mp4' : 'mkv' });
  }
  return out;
}
