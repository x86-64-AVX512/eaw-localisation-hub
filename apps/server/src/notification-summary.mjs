export function textChangeSummary(before, after) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let beforeEnd = before.length; let afterEnd = after.length;
  while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd -= 1; afterEnd -= 1;
  }
  const oldPart = before.slice(start, beforeEnd); const newPart = after.slice(start, afterEnd);
  const words = (value) => (value.match(/\S+/gu) ?? []).length;
  const lines = (value) => value ? value.split(/\r?\n/u).length : 0;
  return {
    lines: Math.max(lines(oldPart), lines(newPart)), words: Math.max(words(oldPart), words(newPart)),
    characters: Math.max([...oldPart].length, [...newPart].length),
  };
}
