import { AuthError } from './auth-model.mjs';

export function spellingWords(store, _actor) {
  return Array.isArray(store.state.spellingWords) ? [...store.state.spellingWords] : [];
}

export async function addSpellingWord(store, _actor, value) {
  const word = String(value ?? '').toLocaleLowerCase('ru');
  if (word.length > 64 || !/^[а-яё]{2,}(?:-[а-яё]{2,})*$/u.test(word)) {
    throw new AuthError('Invalid dictionary word', 400, 'invalid_word');
  }
  const words = [...new Set([...(store.state.spellingWords ?? []), word])];
  if (words.length > 100_000) throw new AuthError('Server dictionary is full', 409, 'dictionary_full');
  store.state.spellingWords = words;
  await store.persist();
  return [...store.state.spellingWords];
}
