// Stage 11: the episode after the current one, from provider-stated numbers only.
// Rules (no guessing):
//   - the current episode and every candidate need provider-stated season and episode numbers
//     (Episode.exact); filled-in numbers never decide;
//   - same season: the smallest stated episode number above the current one (gaps are fine);
//   - otherwise: the first episode of the next higher season number ≥ 1 that has stated episodes;
//   - season 0 (specials) is never continued from and never continued into;
//   - a duplicated number (current or candidate) makes the choice ambiguous: no next episode;
//   - the result is always an episode of the same series (the seasons passed in).
// Catalogue order is not used: seasons and episodes are compared by their numbers.
import type { Episode, Season } from '../models/content.ts';

export type NextResult = { episode: Episode } | { none: 'last' | 'unknown' | 'ambiguous' | 'special' };

function stated(e: Episode): boolean { return e.exact === true; }

export function nextEpisode(seasons: Season[], currentId: string): NextResult {
  let cur: Episode | null = null;
  let hits = 0;
  for (let i = 0; i < seasons.length; i++) {
    const eps = seasons[i].episodes;
    for (let j = 0; j < eps.length; j++) { if (eps[j].id === currentId) { cur = eps[j]; hits++; } }
  }
  if (!cur || hits !== 1) { return { none: hits > 1 ? 'ambiguous' : 'unknown' }; }
  if (!stated(cur)) { return { none: 'unknown' }; }
  if (cur.season === 0) { return { none: 'special' }; }
  const c = cur;
  // Same season, the next stated number; the current number must be unique.
  let best: Episode | null = null;
  let bestCount = 0;
  let sameNumber = 0;
  for (let i = 0; i < seasons.length; i++) {
    const eps = seasons[i].episodes;
    for (let j = 0; j < eps.length; j++) {
      const e = eps[j];
      if (!stated(e) || e.season !== c.season) { continue; }
      if (e.episode === c.episode) { sameNumber++; continue; }
      if (e.episode < c.episode) { continue; }
      if (!best || e.episode < best.episode) { best = e; bestCount = 1; } else if (e.episode === best.episode) { bestCount++; }
    }
  }
  if (sameNumber > 1) { return { none: 'ambiguous' }; }
  if (best) { return bestCount === 1 ? { episode: best } : { none: 'ambiguous' }; }
  // Next season: the smallest season number above the current one (≥ 1) with stated episodes.
  let nextSeason = -1;
  for (let i = 0; i < seasons.length; i++) {
    const eps = seasons[i].episodes;
    for (let j = 0; j < eps.length; j++) {
      const e = eps[j];
      if (stated(e) && e.season > c.season && e.season >= 1 && (nextSeason < 0 || e.season < nextSeason)) { nextSeason = e.season; }
    }
  }
  if (nextSeason < 0) { return { none: 'last' }; }
  let first: Episode | null = null;
  let firstCount = 0;
  for (let i = 0; i < seasons.length; i++) {
    const eps = seasons[i].episodes;
    for (let j = 0; j < eps.length; j++) {
      const e = eps[j];
      if (!stated(e) || e.season !== nextSeason) { continue; }
      if (!first || e.episode < first.episode) { first = e; firstCount = 1; } else if (e.episode === first.episode) { firstCount++; }
    }
  }
  if (!first) { return { none: 'last' }; }
  return firstCount === 1 ? { episode: first } : { none: 'ambiguous' };
}
