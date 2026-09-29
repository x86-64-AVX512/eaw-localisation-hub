import { mergeLocalisationThreeWay } from '../../../packages/shared/src/merge.mts';
import { mergeConflictId, mergeStateRevision } from '../../../packages/shared/src/merge-state.mts';

export function evaluateDiskMerge({ baseText, sharedText, personalText, externalText,
  initialUnknown = false, resolutions = /** @type {Record<string, string>} */ ({}) }) {
  const mergeRevision = mergeStateRevision(baseText, sharedText, personalText, externalText);
  const confirmed = (conflicts) => conflicts.map((conflict) => ({ ...conflict,
    conflictId: mergeConflictId(mergeRevision, conflict.key) }));
  if (initialUnknown) {
    const choice = resolutions.__initial_state__;
    if (choice !== 'collaborative' && choice !== 'external') {
      return { mergeRevision, conflicts: confirmed([{ key: '__initial_state__', label: 'Начальная версия файла',
        baseLine: '', collaborativeLine: sharedText, externalLine: externalText }]) };
    }
    return { mergeRevision, conflicts: [], sharedText: choice === 'external' ? externalText : sharedText,
      personalText: choice === 'external' ? externalText : personalText };
  }
  const shared = mergeLocalisationThreeWay(baseText, sharedText, externalText, resolutions);
  const personal = mergeLocalisationThreeWay(baseText, personalText, externalText, resolutions);
  const conflicts = new Map();
  for (const conflict of [...shared.conflicts, ...personal.conflicts]) {
    if (!conflicts.has(conflict.key)) conflicts.set(conflict.key, conflict);
  }
  return { mergeRevision, conflicts: confirmed([...conflicts.values()]),
    ...(conflicts.size ? {} : { sharedText: shared.text, personalText: personal.text }) };
}
