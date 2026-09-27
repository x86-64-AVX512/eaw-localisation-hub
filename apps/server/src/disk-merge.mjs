import { mergeLocalisationThreeWay } from '../../../packages/shared/src/merge.mts';

export function evaluateDiskMerge({ baseText, sharedText, personalText, externalText,
  initialUnknown = false, resolutions = /** @type {Record<string, string>} */ ({}) }) {
  if (initialUnknown) {
    const choice = resolutions.__initial_state__;
    if (choice !== 'collaborative' && choice !== 'external') {
      return { conflicts: [{ key: '__initial_state__', label: 'Начальная версия файла',
        baseLine: '', collaborativeLine: sharedText, externalLine: externalText }] };
    }
    return { conflicts: [], sharedText: choice === 'external' ? externalText : sharedText,
      personalText: choice === 'external' ? externalText : personalText };
  }
  const shared = mergeLocalisationThreeWay(baseText, sharedText, externalText, resolutions);
  const personal = mergeLocalisationThreeWay(baseText, personalText, externalText, resolutions);
  const conflicts = new Map();
  for (const conflict of [...shared.conflicts, ...personal.conflicts]) {
    if (!conflicts.has(conflict.key)) conflicts.set(conflict.key, conflict);
  }
  return { conflicts: [...conflicts.values()],
    ...(conflicts.size ? {} : { sharedText: shared.text, personalText: personal.text }) };
}
