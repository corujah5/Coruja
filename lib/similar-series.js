'use strict';

const STOP_WORDS = new Set((
  'a ao aos as com como da das de do dos e em entre era essa esse estas estes foi foram ' +
  'ha isso mais mas na nas no nos o os ou para pela pelas pelo pelos por que se sem sua ' +
  'suas seu seus sobre um uma umas uns the and for from into that this when where while ' +
  'who whose their they them have has are was were but not you your our out una uno del ' +
  'los las por con unos unas este esta estos estas y en el le after before during every ' +
  'new one two life story series show world people person man woman young find finds ' +
  'follow follows must become becomes make makes take takes town city years year future ' +
  'about after also another based begins begins become could drama enters every follows ' +
  'gets goes leaves lives moves once returns sets starts takes tells turns while whose'
).split(/\s+/));
const GENERIC_KEYWORDS = new Set([
  'action', 'adventure', 'anime', 'based on manga', 'based on novel', 'based on true story',
  'comedy', 'crime', 'criminal', 'dark', 'dark comedy', 'detective', 'drama', 'fantasy',
  'family', 'family relationships', 'horror', 'investigation', 'investigator', 'manga',
  'miniseries', 'murder', 'mystery', 'police', 'romance', 'science fiction', 'sci fi',
  'supernatural', 'teen', 'thriller', 'future', 'cancer', 'terminal illness', 'tragedy',
  'outlaw', 'drugs', 'drug', 'sitcom', 'friendship', 'young adult', 'survival', 'based on',
  'based on graphic novel', 'spin off', 'prequel', 'sequel', 'new mexico', 'albuquerque new mexico',
  'new york city', 'manhattan new york city', '1980s', 'gritty', 'narcos', 'super power',
  'hero', 'rivalry', 'warrior', 'martial arts'
]);
const GENERIC_SINGLE_WORD_KEYWORDS = new Set([
  'bold', 'dark', 'cancer', 'drama', 'crime', 'criminal', 'drugs', 'drug', 'family', 'friendship',
  'horror', 'investigation', 'murder', 'mystery', 'romance', 'sitcom', 'survival', 'thriller',
  'tragedy', 'outlaw', 'psychopath', 'supernatural', 'teen', 'future', 'adventure', 'action',
  'gritty', 'narcos', 'hero', 'rivalry', 'warrior'
]);
const MIN_SIMILAR_SERIES_SCORE = 50;
const AUDIENCE_STYLE_KEYWORDS = new Set(['shounen', 'seinen', 'shoujo', 'josei']);

function listFrom(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.results)) return value.results;
  return [];
}

function mergeCandidateSources(primary, secondary, limit = 20) {
  const sources = [listFrom(primary), listFrom(secondary)];
  const merged = [];
  const seen = new Set();
  const maxLength = Math.max(...sources.map(source => source.length), 0);
  for (let index = 0; index < maxLength && merged.length < limit; index++) {
    for (const source of sources) {
      const candidate = source[index];
      const id = candidate?.id == null ? '' : String(candidate.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      merged.push(candidate);
      if (merged.length >= limit) break;
    }
  }
  return merged;
}

function idsFrom(values) {
  return new Set(listFrom(values).map(item => {
    if (item && typeof item === 'object') return item.id == null ? '' : String(item.id);
    return item == null ? '' : String(item);
  }).filter(Boolean));
}

function genresFrom(series) {
  return idsFrom(series?.genres?.length ? series.genres : series?.genre_ids);
}

function keywordKeys(values) {
  return new Set(listFrom(values).map(item => {
    if (item && typeof item === 'object') {
      const name = String(item.name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .trim().toLocaleLowerCase('pt-BR').replace(/[^a-z0-9]+/g, ' ');
      if (GENERIC_KEYWORDS.has(name)) return '';
      if (item.id != null) return `id:${item.id}`;
      return name ? `name:${name}` : '';
    }
    const value = String(item || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .trim().toLocaleLowerCase('pt-BR').replace(/[^a-z0-9]+/g, ' ');
    return value && !GENERIC_KEYWORDS.has(value) ? `name:${value}` : '';
  }).filter(Boolean));
}

function keywordName(item) {
  return String(item?.name || item || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .trim().toLocaleLowerCase('pt-BR').replace(/[^a-z0-9]+/g, ' ');
}

function keywordIdentity(item) {
  if (item && typeof item === 'object' && item.id != null) return `id:${item.id}`;
  const name = keywordName(item);
  return name ? `name:${name}` : '';
}

function sharedKeywordNames(currentKeywords, candidateKeywords) {
  const candidates = new Map(listFrom(candidateKeywords).map(item => [keywordIdentity(item), keywordName(item)]));
  return [...new Set(listFrom(currentKeywords).map(item => {
    const key = keywordIdentity(item);
    return key && candidates.has(key) ? candidates.get(key) : '';
  }).filter(name => name && !GENERIC_KEYWORDS.has(name)))];
}

function keywordEvidence(names) {
  const strongPhrases = names.filter(name => {
    const words = name.split(/\s+/).filter(Boolean);
    return words.length >= 2 && !words.every(word => GENERIC_SINGLE_WORD_KEYWORDS.has(word));
  });
  const specificSingles = names.filter(name => {
    const words = name.split(/\s+/).filter(Boolean);
    return words.length === 1 && !GENERIC_SINGLE_WORD_KEYWORDS.has(name);
  });
  return { strongPhrases, specificSingles };
}

function normalizeWord(word) {
  let normalized = String(word || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');
  if (normalized.length > 5 && normalized.endsWith('ies')) normalized = `${normalized.slice(0, -3)}y`;
  else if (normalized.length > 4 && normalized.endsWith('s')) normalized = normalized.slice(0, -1);
  return normalized;
}

function wordsFrom(series) {
  const text = String(series?.overview || '');
  return new Set((text.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR').match(/[a-z0-9]{4,}/g) || [])
    .map(normalizeWord).filter(word => word && !STOP_WORDS.has(word)));
}

function phrasesFrom(series) {
  const text = String(series?.overview || '');
  const words = (text.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR').match(/[a-z0-9]{3,}/g) || [])
    .map(normalizeWord).filter(word => word && !STOP_WORDS.has(word));
  const phrases = new Set();
  for (let index = 0; index < words.length - 1; index++) phrases.add(`${words[index]} ${words[index + 1]}`);
  return phrases;
}

function isAnime(series, keywords) {
  const names = listFrom(keywords).map(item => String(item?.name || item || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR'));
  return names.some(name => /\b(anime|manga|shounen|seinen)\b/.test(name));
}

function normalizedKeywordNames(values) {
  return new Set(listFrom(values).map(item => String(item?.name || item || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR')
    .trim().replace(/[^a-z0-9]+/g, ' ')).filter(Boolean));
}

function intersectionCount(a, b) {
  let count = 0;
  for (const value of a) if (b.has(value)) count++;
  return count;
}

function jaccard(a, b, common = intersectionCount(a, b)) {
  const union = a.size + b.size - common;
  return union ? common / union : 0;
}

function scoreSimilarSeries({ current, candidate, currentKeywords, candidateKeywords, sourceIndex = 0 }) {
  const currentGenres = genresFrom(current);
  const candidateGenres = genresFrom(candidate);
  const sharedGenres = intersectionCount(currentGenres, candidateGenres);
  if (!sharedGenres) return null;

  const currentIsAnimated = currentGenres.has('16');
  const candidateIsAnimated = candidateGenres.has('16');
  const currentIsAnime = isAnime(current, currentKeywords);
  const candidateIsAnime = isAnime(candidate, candidateKeywords);
  if (currentIsAnimated !== candidateIsAnimated || currentIsAnime !== candidateIsAnime) return null;

  const currentKeywordKeys = keywordKeys(currentKeywords);
  const candidateKeywordKeys = keywordKeys(candidateKeywords);
  const sharedKeywordEntries = sharedKeywordNames(currentKeywords, candidateKeywords);
  const keywordSignals = keywordEvidence(sharedKeywordEntries);
  const sharedAudienceStyle = intersectionCount(
    new Set([...normalizedKeywordNames(currentKeywords)].filter(name => AUDIENCE_STYLE_KEYWORDS.has(name))),
    new Set([...normalizedKeywordNames(candidateKeywords)].filter(name => AUDIENCE_STYLE_KEYWORDS.has(name)))
  );
  const currentWords = wordsFrom(current);
  const candidateWords = wordsFrom(candidate);
  const currentPhrases = phrasesFrom(current);
  const candidatePhrases = phrasesFrom(candidate);
  const sharedKeywords = intersectionCount(currentKeywordKeys, candidateKeywordKeys);
  const sharedWords = intersectionCount(currentWords, candidateWords);
  const sharedPhrases = intersectionCount(currentPhrases, candidatePhrases);
  const genreJaccard = jaccard(currentGenres, candidateGenres, sharedGenres);
  const keywordCoverage = sharedKeywords / Math.max(1, Math.min(currentKeywordKeys.size, candidateKeywordKeys.size));

  // Gêneros e tags de formato, sozinhos, são amplos. A aprovação exige um tema
  // específico do TMDB corroborado por contexto, ou forte sobreposição de sinopses.
  const hasThematicEvidence = (keywordSignals.strongPhrases.length >= 1
      && (sharedGenres >= 2 || (sharedWords >= 3 && sharedPhrases >= 1)))
    || (keywordSignals.strongPhrases.length >= 2 && sharedGenres >= 1)
    || (keywordSignals.specificSingles.length >= 2 && sharedGenres >= 1
      && sharedWords >= 3 && sharedPhrases >= 1)
    || (sharedGenres >= 2 && sharedWords >= 5 && sharedPhrases >= 2);
  const unmatchedGenres = (currentGenres.size - sharedGenres) + (candidateGenres.size - sharedGenres);
  const languageBonus = current?.original_language && current.original_language === candidate?.original_language ? 2 : 0;
  const countryBonus = Array.isArray(current?.origin_country) && Array.isArray(candidate?.origin_country)
    && current.origin_country.some(country => candidate.origin_country.includes(country)) ? 2 : 0;
  const animeStyleBonus = currentIsAnime && candidateIsAnime ? 2 : 0;
  const audienceStyleBonus = sharedAudienceStyle ? 5 : 0;
  const sourceBonus = Math.max(0, 2 - sourceIndex / 10);
  const score = genreJaccard * 12
    + Math.min(keywordSignals.strongPhrases.length, 2) * 38
    + Math.min(keywordSignals.specificSingles.length, 2) * 20
    + Math.min(sharedWords, 6) * 4
    + Math.min(sharedPhrases, 4) * 5
    + keywordCoverage * 3
    + languageBonus + countryBonus + animeStyleBonus + audienceStyleBonus + sourceBonus
    - unmatchedGenres * 4;

  return {
    score: Math.round(Math.max(0, score) * 100) / 100,
    sharedGenres,
    sharedKeywords,
    sharedKeywordNames: sharedKeywordEntries,
    strongKeywordMatches: keywordSignals.strongPhrases.length,
    specificSingleKeywordMatches: keywordSignals.specificSingles.length,
    sharedWords,
    sharedPhrases,
    genreJaccard,
    keywordCoverage,
    hasThematicEvidence
  };
}

function rankSimilarSeries({ current, candidates, currentKeywords, keywordsById, limit = 10, minimumScore = MIN_SIMILAR_SERIES_SCORE }) {
  const currentId = Number(current?.id);
  const seen = new Set(Number.isSafeInteger(currentId) ? [currentId] : []);
  const ranked = [];

  listFrom(candidates).forEach((candidate, sourceIndex) => {
    const id = Number(candidate?.id);
    if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id) || !(candidate?.name || candidate?.original_name)) return;
    seen.add(id);
    const candidateKeywords = keywordsById instanceof Map
      ? keywordsById.get(id) ?? keywordsById.get(String(id))
      : keywordsById?.[id];
    const relevance = scoreSimilarSeries({ current, candidate, currentKeywords, candidateKeywords, sourceIndex });
    if (!relevance || !relevance.hasThematicEvidence || relevance.score < minimumScore) return;
    ranked.push({ candidate: { ...candidate, media_type: 'tv' }, ...relevance, sourceIndex });
  });

  return ranked.sort((a, b) => b.score - a.score || a.sourceIndex - b.sourceIndex)
    .slice(0, Math.max(0, Number(limit) || 0)).map(item => item.candidate);
}

module.exports = { MIN_SIMILAR_SERIES_SCORE, mergeCandidateSources, rankSimilarSeries, scoreSimilarSeries };
