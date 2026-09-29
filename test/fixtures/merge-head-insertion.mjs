import { mergeLocalisationThreeWay } from '../../packages/shared/src/merge.mts';
const base = ' b:0 "B"\n';
const result = mergeLocalisationThreeWay(base, base, ' a:0 "A"\n' + base);
console.log(JSON.stringify(result));
