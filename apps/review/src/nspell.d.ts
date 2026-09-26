declare module 'nspell' {
  export interface NSpellChecker {
    correct(word: string): boolean;
    suggest(word: string): string[];
  }

  export default function nspell(dictionary: { aff: string; dic: string }): NSpellChecker;
}
