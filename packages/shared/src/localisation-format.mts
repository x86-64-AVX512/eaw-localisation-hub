// Only structural checks supported by the researched formatter. Letters may
// be colour codes; unknown letters are not rejected by a guessed whitelist.
export function suspiciousLocalisationFormat(format: string): boolean {
  let percent = false;
  for (let index = 0; index < format.length; index += 1) {
    if (format[index] === '%') {
      if (percent && format[index - 1] !== '%') return true;
      percent = true;
    }
    if (format[index] === '.' && !/[0-9]/u.test(format[index + 1] ?? '')) return true;
  }
  return false;
}
