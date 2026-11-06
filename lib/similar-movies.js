'use strict';

const { mergeCandidateSources } = require('./similar-series');

const MIN_SIMILAR_MOVIE_SCORE = 50;
const GENERIC_KEYWORDS = new Set([
  'action', 'adventure', 'anime', 'based on', 'based on book', 'based on novel',
  'based on novel or book', 'based on true story', 'based on a true story',
  'based on real events', 'based on comic book', 'based on manga', 'biography',
  'comedy', 'crime', 'criminal', 'dark', 'dark comedy', 'detective', 'drama',
  'family', 'family relationships', 'fantasy', 'horror', 'investigation',
  'investigator', 'manga', 'miniseries', 'murder', 'mystery', 'police',
  'romance', 'science fiction', 'sci fi', 'supernatural', 'teen', 'thriller',
  'future', 'tragedy', 'outlaw', 'drugs', 'drug', 'sitcom', 'friendship',
  'young adult', 'survival', 'war', 'violence', 'revenge', 'love',
  'sequel', 'prequel', 'remake', 'independent film', 'coming of age',
  'new york city', 'los angeles', '1970s', '1980s', '1990s', '2000s',
  'based on novel', 'based on book', 'true crime', 'real life', 'italy',
  'mexico', 'florida', 'tampa florida', 'brooklyn new york city',
  '1950s', '1960s', '2010s', 'sibling relationship',
  'parent child relationship', 'brother brother relationship',
  '3d animation', 'computer animation', 'animated film', 'animation',
  'musician', 'guitar'
]);
const GENERIC_SINGLE_WORD_KEYWORDS = new Set([
  'action', 'adventure', 'anime', 'biography', 'comedy', 'crime', 'criminal',
  'dark', 'drama', 'family', 'fantasy', 'horror', 'investigation', 'manga',
  'murder', 'mystery', 'police', 'romance', 'supernatural', 'teen', 'thriller',
  'future', 'tragedy', 'outlaw', 'drugs', 'drug', 'sitcom', 'friendship',
  'survival', 'war', 'violence', 'revenge', 'love', 'dream', 'dreams', 'mission',
  'spy', 'agent', 'heist', 'musician', 'guitar', 'villain', 'hilarious', 'hopeful',
  'kids', 'music', 'boy', 'singer', 'cartoon'
]);
const STOP_WORDS = new Set((
  'a ao aos as com como da das de do dos e em entre era essa esse estas estes foi foram ha ' +
  'isso mais mas na nas no nos o os ou para pela pelas pelo pelos por que se sem sua suas ' +
  'seu sobre um uma umas uns the and for from into that this when where while who whose ' +
  'their they them have has are was were but not you your our out with after before during ' +
  'every new one two life story film movie people person man woman young find follows must ' +
  'become makes take town city years year about also another begins could gets goes leaves ' +
  'lives moves once returns sets starts tells turns based film about from into over under'
).split(/\s+/));

function listFrom(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.results)) return value.results;
  return [];
}

function normalize(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR').trim().replace(/[^a-z0-9]+/g, ' ').trim();
}

function genreIds(movie) {
  const genres = Array.isArray(movie?.genres) && movie.genres.length
    ? movie.genres.map(item => item?.id)
    : Array.isArray(movie?.genre_ids) ? movie.genre_ids : [];
  return new Set(genres.map(id => String(id ?? '')).filter(Boolean));
}

function keywordIdentity(item) {
  if (item && typeof item === 'object' && item.id != null) return `id:${item.id}`;
  const name = normalize(item?.name ?? item);
  return name ? `name:${name}` : '';
}

function keywordName(item) {
  return normalize(item?.name ?? item);
}

function sharedKeywordNames(currentKeywords, candidateKeywords) {
  const candidateNames = new Map(listFrom(candidateKeywords).map(item => [keywordIdentity(item), keywordName(item)]));
  return [...new Set(listFrom(currentKeywords).map(item => {
    const identity = keywordIdentity(item);
    return identity && candidateNames.has(identity) ? candidateNames.get(identity) : '';
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
  let normalized = normalize(word);
  if (normalized.length > 5 && normalized.endsWith('ies')) normalized = `${normalized.slice(0, -3)}y`;
  else if (normalized.length > 4 && normalized.endsWith('s')) normalized = normalized.slice(0, -1);
  return normalized;
}

function synopsisWords(movie) {
  const tokens = normalize(movie?.overview).split(/\s+/)
    .map(normalizeWord).filter(word => word.length >= 4 && !STOP_WORDS.has(word));
  return new Set(tokens);
}

function synopsisPhrases(movie) {
  const tokens = normalize(movie?.overview).split(/\s+/)
    .map(normalizeWord).filter(word => word.length >= 3 && !STOP_WORDS.has(word));
  const phrases = new Set();
  for (let index = 0; index < tokens.length - 1; index++) {
    phrases.add(`${tokens[index]} ${tokens[index + 1]}`);
  }
  return phrases;
}

function intersectionCount(a, b) {
  let count = 0;
  for (const item of a) if (b.has(item)) count++;
  return count;
}

function jaccard(a, b, common = intersectionCount(a, b)) {
  const union = a.size + b.size - common;
  return union ? common / union : 0;
}

function scoreSimilarMovie({ current, candidate, currentKeywords, candidateKeywords, sourceIndex = 0 }) {
  if (candidate?.media_type && candidate.media_type !== 'movie') return null;
  const currentGenres = genreIds(current);
  const candidateGenres = genreIds(candidate);
  const sharedGenres = intersectionCount(currentGenres, candidateGenres);
  if (!sharedGenres) return null;

  // A animação tem linguagem e público próprios; gênero amplo compartilhado
  // não deve misturá-la com filmes live action.
  const currentIsAnimated = currentGenres.has('16');
  const candidateIsAnimated = candidateGenres.has('16');
  if (currentIsAnimated !== candidateIsAnimated) return null;

  const sharedNames = sharedKeywordNames(currentKeywords, candidateKeywords);
  const evidence = keywordEvidence(sharedNames);
  const currentWords = synopsisWords(current);
  const candidateWords = synopsisWords(candidate);
  const currentPhrases = synopsisPhrases(current);
  const candidatePhrases = synopsisPhrases(candidate);
  const sharedWords = intersectionCount(currentWords, candidateWords);
  const sharedPhrases = intersectionCount(currentPhrases, candidatePhrases);
  const currentKeys = new Set(listFrom(currentKeywords).map(keywordIdentity).filter(Boolean));
  const candidateKeys = new Set(listFrom(candidateKeywords).map(keywordIdentity).filter(Boolean));
  const sharedKeywords = intersectionCount(currentKeys, candidateKeys);
  const genreJaccard = jaccard(currentGenres, candidateGenres, sharedGenres);
  const keywordCoverage = sharedKeywords / Math.max(1, Math.min(currentKeys.size, candidateKeys.size));

  // Exigir tema específico: dois sinais distintos de palavra-chave, uma tag
  // específica corroborada pela sinopse, ou forte sobreposição de contexto.
  // Coincidência de gênero ou de tags genéricas nunca aprova um candidato.
  const hasThematicEvidence = (evidence.strongPhrases.length >= 1
      && (sharedGenres >= 2 || (sharedWords >= 3 && sharedPhrases >= 1)))
    || (evidence.strongPhrases.length >= 2 && sharedGenres >= 1)
    || (evidence.specificSingles.length >= 2 && sharedGenres >= 1)
    || (evidence.strongPhrases.length >= 1 && evidence.specificSingles.length >= 1
      && sharedGenres >= 1 && sharedWords >= 2);

  const unmatchedGenres = (currentGenres.size - sharedGenres) + (candidateGenres.size - sharedGenres);
  const languageBonus = current?.original_language && current.original_language === candidate?.original_language ? 2 : 0;
  const sourceBonus = Math.max(0, 2 - sourceIndex / 10);
  const score = genreJaccard * 12
    + Math.min(evidence.strongPhrases.length, 2) * 50
    + Math.min(evidence.specificSingles.length, 2) * 26
    + Math.min(sharedWords, 6) * 4
    + Math.min(sharedPhrases, 4) * 5
    + keywordCoverage * 3
    + languageBonus + sourceBonus
    - unmatchedGenres * 4;

  return {
    score: Math.round(Math.max(0, score) * 100) / 100,
    sharedGenres,
    sharedKeywords,
    sharedKeywordNames: sharedNames,
    strongKeywordMatches: evidence.strongPhrases.length,
    specificSingleKeywordMatches: evidence.specificSingles.length,
    sharedWords,
    sharedPhrases,
    genreJaccard,
    keywordCoverage,
    hasThematicEvidence
  };
}

function rankSimilarMovies({ current, candidates, currentKeywords, keywordsById, limit = 10, minimumScore = MIN_SIMILAR_MOVIE_SCORE }) {
  const currentId = Number(current?.id);
  const seen = new Set(Number.isSafeInteger(currentId) ? [currentId] : []);
  const ranked = [];

  listFrom(candidates).forEach((candidate, sourceIndex) => {
    const id = Number(candidate?.id);
    if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id)
      || candidate?.media_type && candidate.media_type !== 'movie'
      || !(candidate?.title || candidate?.original_title)) return;
    seen.add(id);
    const candidateKeywords = keywordsById instanceof Map
      ? keywordsById.get(id) ?? keywordsById.get(String(id))
      : keywordsById?.[id];
    const relevance = scoreSimilarMovie({ current, candidate, currentKeywords, candidateKeywords, sourceIndex });
    if (!relevance?.hasThematicEvidence || relevance.score < minimumScore) return;
    ranked.push({ candidate: { ...candidate, media_type: 'movie' }, ...relevance, sourceIndex });
  });

  return ranked.sort((a, b) => b.score - a.score || a.sourceIndex - b.sourceIndex)
    .slice(0, Math.max(0, Number(limit) || 0)).map(item => item.candidate);
}

module.exports = { MIN_SIMILAR_MOVIE_SCORE, mergeCandidateSources, rankSimilarMovies, scoreSimilarMovie };
