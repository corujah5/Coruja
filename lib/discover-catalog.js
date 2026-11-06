'use strict';

const MAX_PAGE = 500;
const MAX_GENRES = 8;

function localDateKey(date = new Date(), timeZone = 'America/Sao_Paulo') {
  const parts = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function normalizeDiscoverQuery(query = {}, today = new Date().toISOString().slice(0, 10)) {
  const mediaType = String(query.type || 'movie').toLowerCase();
  if (!['movie', 'tv'].includes(mediaType)) throw new TypeError('Tipo de catálogo inválido.');

  const allowedSources = mediaType === 'movie'
    ? ['trending', 'popular', 'top_rated', 'upcoming']
    : ['trending', 'popular', 'top_rated'];
  const source = String(query.source || 'trending').toLowerCase();
  if (!allowedSources.includes(source)) throw new TypeError('Categoria de catálogo inválida.');

  const rawPage = Number(query.page || 1);
  const page = Number.isInteger(rawPage) ? Math.max(1, Math.min(MAX_PAGE, rawPage)) : 1;
  const currentYear = Number(String(today).slice(0, 4)) || new Date().getUTCFullYear();
  const rawYear = String(query.year || '').trim();
  const year = rawYear && /^\d{4}$/.test(rawYear) && Number(rawYear) >= 1870 && Number(rawYear) <= currentYear + 10
    ? rawYear
    : '';

  const genres = Array.from(new Set(String(query.genres || '').split(',')
    .map(value => value.trim())
    .filter(value => /^\d{1,6}$/.test(value) && Number(value) > 0)))
    .slice(0, MAX_GENRES);

  let status = String(query.status || 'all').toLowerCase();
  if (mediaType !== 'tv') status = 'all';
  if (!['all', 'ongoing', 'ended'].includes(status)) status = 'all';

  return { mediaType, source, page, year, genres, status, today: /^\d{4}-\d{2}-\d{2}$/.test(today) ? today : new Date().toISOString().slice(0, 10) };
}

function buildDiscoverRequest(filters) {
  const { mediaType, source, page, year, genres, status, today } = filters;
  const hasDiscoverFilters = !!year || genres.length > 0 || status !== 'all';
  const useDiscover = hasDiscoverFilters;
  const params = { language: 'pt-BR', page };

  if (mediaType === 'movie') params.region = 'BR';

  if (!useDiscover) {
    if (source === 'trending') return { endpoint: `/trending/${mediaType}/week`, params: { language: 'pt-BR', page } };
    if (source === 'popular') return { endpoint: `/${mediaType}/popular`, params };
    if (source === 'top_rated') return { endpoint: `/${mediaType}/top_rated`, params };
    return { endpoint: '/movie/upcoming', params: { ...params, region: 'BR' } };
  }

  const sortBy = source === 'top_rated'
    ? 'vote_average.desc'
    : source === 'upcoming'
      ? 'primary_release_date.asc'
      : mediaType === 'movie'
        ? 'popularity.desc'
        : 'popularity.desc';
  params.sort_by = sortBy;
  params.include_adult = 'false';
  if (genres.length) params.with_genres = genres.join(',');

  if (mediaType === 'movie') {
    if (year) params.primary_release_year = year;
    if (source === 'upcoming') params['primary_release_date.gte'] = today;
  } else {
    if (year) params.first_air_date_year = year;
    if (status === 'ongoing') params.with_status = '0|2';
    if (status === 'ended') params.with_status = '3|4';
  }

  return { endpoint: `/discover/${mediaType}`, params };
}

function filterUpcomingPayload(payload, today) {
  const safeToday = /^\d{4}-\d{2}-\d{2}$/.test(today) ? today : new Date().toISOString().slice(0, 10);
  const results = Array.isArray(payload?.results) ? payload.results : [];
  return {
    ...payload,
    results: results.filter(item => /^\d{4}-\d{2}-\d{2}$/.test(String(item?.release_date || '')) && item.release_date >= safeToday)
  };
}

module.exports = { localDateKey, normalizeDiscoverQuery, buildDiscoverRequest, filterUpcomingPayload };
