import { parseRange, type SheetRange, type SheetValue } from '../../shared/sheets';

/**
 * The one array formula people and models both reach for, computed here
 * because the engine does not: "the values of this column on the rows that
 * match, in one cell".
 *
 *   TEXTJOIN(", ", TRUE, IF(Data!$A$2:$A$90=$A2, Data!$C$2:$C$90, ""))
 *   TEXTJOIN(", ", TRUE, FILTER(Data!$C$2:$C$90, (Data!$A$2:$A$90=$A2)*(Data!$B$2:$B$90="x")))
 *
 * IronCalc answers both with #N/IMPL!. A model that got that built a helper
 * sheet of 1,702 formulas to list each group's codes without it, and spent
 * most of a million tokens doing so (a run, 16.11). Excel computes the
 * formula; so does this, for exactly that shape — a join of one vector,
 * chosen by comparisons of other vectors of the same length, summed and
 * multiplied as "or" and "and" — and nothing wider: anything it does not
 * recognise it leaves alone.
 */
type Token = { kind: 'text' | 'number' | 'name' | 'ref' | 'op'; value: string; sheet?: string };
type Operand = { range: SheetRange; sheet?: string } | { value: SheetValue };
type Condition =
  | { op: '+' | '*'; left: Condition; right: Condition }
  | { op: '=' | '<>' | '>' | '<' | '>=' | '<='; left: Operand; right: Operand };
export interface ListFormula { separator: Operand; skipEmpty: boolean; values: { range: SheetRange; sheet?: string }; when: Condition }

const REF = /^(?:'((?:[^']|'')+)'!|([A-Za-z_][\w.]*)!)?(\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?)/;

function tokens(formula: string): Token[] | null {
  const found: Token[] = [];
  let rest = formula.trim().replace(/^=/, '');
  while (rest) {
    const space = /^\s+/.exec(rest);
    if (space) { rest = rest.slice(space[0].length); continue; }
    if (rest[0] === '"') {
      const text = /^"((?:[^"]|"")*)"/.exec(rest);
      if (!text) return null;
      found.push({ kind: 'text', value: text[1].replace(/""/g, '"') });
      rest = rest.slice(text[0].length);
      continue;
    }
    const ref = REF.exec(rest);
    // A reference, not the start of a longer name: A1 in "A1B" is no cell.
    if (ref && !/^[\w.(]/.test(rest.slice(ref[0].length))) {
      found.push({ kind: 'ref', value: ref[3].replace(/\$/g, '').toUpperCase(), ...(ref[1] !== undefined ? { sheet: ref[1].replace(/''/g, "'") } : ref[2] !== undefined ? { sheet: ref[2] } : {}) });
      rest = rest.slice(ref[0].length);
      continue;
    }
    const number = /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
    if (number) { found.push({ kind: 'number', value: number[0] }); rest = rest.slice(number[0].length); continue; }
    const name = /^(?:_xlfn\.)?(?:_xlws\.)?([A-Za-z][\w.]*)/.exec(rest);
    if (name) { found.push({ kind: 'name', value: name[1].toUpperCase() }); rest = rest.slice(name[0].length); continue; }
    const op = /^(?:<>|>=|<=|[=<>+*(),])/.exec(rest);
    if (!op) return null;
    found.push({ kind: 'op', value: op[0] });
    rest = rest.slice(op[0].length);
  }
  return found;
}

/** The formula as a list to compute, or null when it is anything else. */
export function listFormula(formula: string): ListFormula | null {
  const all = tokens(formula);
  if (!all) return null;
  let at = 0;
  const peek = () => all[at];
  const take = (kind: Token['kind'], value?: string) => { const token = all[at]; if (!token || token.kind !== kind || (value !== undefined && token.value !== value)) throw new Error('shape'); at++; return token; };
  const vector = (token: Token) => {
    const range = parseRange(token.value);
    if (range.top !== range.bottom && range.left !== range.right) throw new Error('shape');
    return { range, ...(token.sheet !== undefined ? { sheet: token.sheet } : {}) };
  };
  const operand = (): Operand => {
    const token = all[at++];
    if (!token) throw new Error('shape');
    if (token.kind === 'ref') return vector(token);
    if (token.kind === 'text') return { value: token.value };
    if (token.kind === 'number') return { value: Number(token.value) };
    if (token.kind === 'name' && (token.value === 'TRUE' || token.value === 'FALSE')) return { value: token.value === 'TRUE' };
    throw new Error('shape');
  };
  const comparison = (): Condition => {
    if (peek()?.kind === 'op' && peek().value === '(') { at++; const inner = sum(); take('op', ')'); return inner; }
    const left = operand();
    const op = take('op').value;
    if (!['=', '<>', '>', '<', '>=', '<='].includes(op)) throw new Error('shape');
    return { op: op as '=', left, right: operand() };
  };
  const product = (): Condition => { let left = comparison(); while (peek()?.kind === 'op' && peek().value === '*') { at++; left = { op: '*', left, right: comparison() }; } return left; };
  const sum = (): Condition => { let left = product(); while (peek()?.kind === 'op' && peek().value === '+') { at++; left = { op: '+', left, right: product() }; } return left; };
  try {
    take('name', 'TEXTJOIN'); take('op', '(');
    const separator = operand();
    take('op', ',');
    const flag = all[at++];
    const skipEmpty = flag?.kind === 'name' ? flag.value === 'TRUE' : flag?.kind === 'number' ? Number(flag.value) !== 0 : (() => { throw new Error('shape'); })();
    take('op', ',');
    const kind = take('name').value;
    take('op', '(');
    let values: ListFormula['values'], when: Condition;
    if (kind === 'IF') {
      when = sum(); take('op', ',');
      values = vector(take('ref')); take('op', ',');
      if (take('text').value !== '') throw new Error('shape');
    } else if (kind === 'FILTER') {
      values = vector(take('ref')); take('op', ',');
      when = sum();
      if (peek()?.kind === 'op' && peek().value === ',') { at++; operand(); }
    } else throw new Error('shape');
    take('op', ')'); take('op', ')');
    if (at !== all.length) return null;
    return { separator, skipEmpty, values, when };
  } catch { return null; }
}

const size = (range: SheetRange) => Math.max(range.bottom - range.top + 1, range.right - range.left + 1);
const blank = (value: SheetValue) => value === null || value === '';
/** As Excel compares: text without regard to case, an empty cell equal to "" and to 0, a number never equal to a text. */
function compare(op: string, left: SheetValue, right: SheetValue): boolean {
  const a = blank(left) ? (typeof right === 'number' ? 0 : '') : left, b = blank(right) ? (typeof left === 'number' ? 0 : '') : right;
  const same = typeof a === typeof b;
  const x = typeof a === 'string' ? a.toLowerCase() : a, y = typeof b === 'string' ? b.toLowerCase() : b;
  const equal = same && x === y;
  // Across kinds Excel orders numbers before text before TRUE/FALSE.
  const rank = (value: SheetValue) => typeof value === 'number' ? 0 : typeof value === 'string' ? 1 : 2;
  const order = equal ? 0 : !same ? rank(a) - rank(b) : (x as number | string | boolean) < (y as number | string | boolean) ? -1 : 1;
  return op === '=' ? equal : op === '<>' ? !equal : op === '>' ? order > 0 : op === '<' ? order < 0 : op === '>=' ? order >= 0 : order <= 0;
}

/**
 * What the list comes to. `cell` reads one cell of the workbook as it stands —
 * a formula's computed value — on the named sheet, or on the formula's own.
 * Returns an Excel error text where Excel would give one.
 */
export function listValue(parsed: ListFormula, cell: (sheet: string | undefined, row: number, column: number) => SheetValue): string {
  const length = size(parsed.values.range);
  if (length > 200_000) return '#VALUE!';
  const at = (operand: Operand, index: number): SheetValue => {
    if (!('range' in operand)) return operand.value;
    const { range } = operand;
    if (size(range) === 1) return cell(operand.sheet, range.top, range.left);
    return range.left === range.right ? cell(operand.sheet, range.top + index, range.left) : cell(operand.sheet, range.top, range.left + index);
  };
  const joined = (condition: Condition): condition is Extract<Condition, { op: '+' | '*' }> => condition.op === '+' || condition.op === '*';
  // Every vector compared is as long as the one listed, or a single cell.
  const lengths = (condition: Condition): boolean => joined(condition) ? lengths(condition.left) && lengths(condition.right)
    : [condition.left, condition.right].every(side => !('range' in side) || size(side.range) === 1 || size(side.range) === length);
  if (!lengths(parsed.when)) return '#N/A';
  const truth = (condition: Condition, index: number): number => !joined(condition) ? Number(compare(condition.op, at(condition.left, index), at(condition.right, index)))
    : condition.op === '+' ? truth(condition.left, index) + truth(condition.right, index) : truth(condition.left, index) * truth(condition.right, index);
  const parts: string[] = [];
  for (let index = 0; index < length; index++) {
    const value = truth(parsed.when, index) ? at(parsed.values, index) : '';
    if (blank(value) && parsed.skipEmpty) continue;
    parts.push(value === null ? '' : typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : String(value));
  }
  const separator = at(parsed.separator, 0);
  const text = parts.join(separator === null ? '' : String(separator));
  return text.length > 32_767 ? '#VALUE!' : text;
}
