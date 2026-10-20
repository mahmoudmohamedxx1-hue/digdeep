/**
 * P1-3 Compute tool, Phase 0 — safe arithmetic and dataset statistics inside
 * the research loop. NO eval / Function / new Function: a hand-rolled
 * recursive-descent parser producing an AST, then a guarded evaluator.
 *
 * The LLM emits `[[COMPUTE <expr>]]` in drafts/findings; the engine intercepts,
 * evaluates, substitutes the result, and emits a `compute` activity event that
 * renders in the evidence rail.
 *
 * Supported: numbers, + - * / % ^, parentheses, commas, and these functions:
 *   sum, mean, median, min, max, stdev, count, abs, round, floor, ceil, sqrt,
 *   ln, log10, exp, pow, pct (a is what % of b), growth (pct change a→b)
 */

export interface ComputeResult {
  ok: boolean;
  value?: number;
  error?: string;
  expr: string;
}

type Fn = (...a: number[]) => number;

const FUNCS: Record<string, { fn: Fn; arity: number | "var" }> = {
  sum: { fn: (...a) => a.reduce((x, y) => x + y, 0), arity: "var" },
  mean: { fn: (...a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN), arity: "var" },
  median: {
    fn: (...a) => {
      if (!a.length) return NaN;
      const s = [...a].sort((x, y) => x - y);
      const m = Math.floor(s.length / 2);
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    },
    arity: "var",
  },
  min: { fn: (...a) => Math.min(...a), arity: "var" },
  max: { fn: (...a) => Math.max(...a), arity: "var" },
  stdev: {
    fn: (...a) => {
      if (a.length < 2) return NaN;
      const m = a.reduce((x, y) => x + y, 0) / a.length;
      return Math.sqrt(a.reduce((acc, x) => acc + (x - m) ** 2, 0) / (a.length - 1));
    },
    arity: "var",
  },
  count: { fn: (...a) => a.length, arity: "var" },
  abs: { fn: (x) => Math.abs(x), arity: 1 },
  round: { fn: (x, d = 0) => Number(Math.round(Number(`${x}e${d}`)) + `e-${d}`), arity: 2 },
  floor: { fn: (x) => Math.floor(x), arity: 1 },
  ceil: { fn: (x) => Math.ceil(x), arity: 1 },
  sqrt: { fn: (x) => Math.sqrt(x), arity: 1 },
  ln: { fn: (x) => Math.log(x), arity: 1 },
  log10: { fn: (x) => Math.log10(x), arity: 1 },
  exp: { fn: (x) => Math.exp(x), arity: 1 },
  pow: { fn: (x, y) => Math.pow(x, y), arity: 2 },
  pct: { fn: (a, b) => (b === 0 ? NaN : (a / b) * 100), arity: 2 },
  growth: { fn: (a, b) => (a === 0 ? NaN : ((b - a) / Math.abs(a)) * 100), arity: 2 },
};

type Node =
  | { k: "num"; v: number }
  | { k: "bin"; op: string; a: Node; b: Node }
  | { k: "neg"; a: Node }
  | { k: "fn"; name: string; args: Node[] };

class Parser {
  private i = 0;
  private nodes = 0;
  constructor(private src: string) {}
  private peek(): string { return this.src[this.i]; }
  private eat(c: string): boolean {
    while (/\s/.test(this.peek() ?? "")) this.i++;
    if (this.peek() === c) { this.i++; return true; }
    return false;
  }
  private skipWs(): void { while (/\s/.test(this.peek() ?? "")) this.i++; }
  parse(): Node {
    const n = this.expr();
    this.skipWs();
    if (this.i < this.src.length) throw new Error(`Unexpected "${this.src.slice(this.i, this.i + 8)}"`);
    return n;
  }
  private node<T extends Node>(n: T): T {
    if (++this.nodes > 400) throw new Error("Expression too complex");
    return n;
  }
  private expr(): Node {
    let a = this.term();
    for (;;) {
      this.skipWs();
      const c = this.peek();
      if (c === "+" || c === "-") { this.i++; a = this.node({ k: "bin", op: c, a, b: this.term() }); }
      else return a;
    }
  }
  private term(): Node {
    let a = this.unary();
    for (;;) {
      this.skipWs();
      const c = this.peek();
      if (c === "*" || c === "/" || c === "%") { this.i++; a = this.node({ k: "bin", op: c, a, b: this.unary() }); }
      else return a;
    }
  }
  private unary(): Node {
    this.skipWs();
    const c = this.peek();
    if (c === "-") { this.i++; return this.node({ k: "neg", a: this.unary() }); }
    if (c === "+") { this.i++; return this.unary(); }
    return this.power();
  }
  private power(): Node {
    const a = this.atom();
    this.skipWs();
    if (this.peek() === "^") { this.i++; return this.node({ k: "bin", op: "^", a, b: this.unary() }); }
    return a;
  }
  private atom(): Node {
    this.skipWs();
    const c = this.peek();
    if (!c) throw new Error("Unexpected end of expression");
    if (/[0-9.]/.test(c)) {
      let j = this.i;
      while (j < this.src.length && /[0-9._]/.test(this.src[j])) j++;
      const raw = this.src.slice(this.i, j).replace(/_/g, "");
      const v = Number(raw);
      if (!Number.isFinite(v)) throw new Error(`Bad number "${raw}"`);
      this.i = j;
      return this.node({ k: "num", v });
    }
    if (/[a-zA-Z_]/.test(c)) {
      let j = this.i;
      while (j < this.src.length && /[a-zA-Z0-9_]/.test(this.src[j])) j++;
      const name = this.src.slice(this.i, j).toLowerCase();
      const spec = FUNCS[name];
      if (!spec) throw new Error(`Unknown function "${name}"`);
      this.i = j;
      if (!this.eat("(")) throw new Error(`Expected "(" after ${name}`);
      const args: Node[] = [];
      this.skipWs();
      if (this.peek() !== ")") {
        args.push(this.expr());
        while (this.eat(",")) args.push(this.expr());
      }
      if (!this.eat(")")) throw new Error(`Expected ")" after ${name}`);
      if (spec.arity !== "var" && args.length > spec.arity) throw new Error(`${name} takes at most ${spec.arity} argument(s)`);
      if (spec.arity === "var" && args.length === 0 && name !== "count") throw new Error(`${name} needs at least one argument`);
      return this.node({ k: "fn", name, args });
    }
    if (c === "(") {
      this.i++;
      const inner = this.expr();
      if (!this.eat(")")) throw new Error(`Expected ")" to close group`);
      return inner;
    }
    throw new Error(`Unexpected character "${c}"`);
  }
}

function evalNode(n: Node): number {
  switch (n.k) {
    case "num":
      return n.v;
    case "neg":
      return -evalNode(n.a);
    case "bin": {
      const a = evalNode(n.a);
      const b = evalNode(n.b);
      switch (n.op) {
        case "+": return a + b;
        case "-": return a - b;
        case "*": return a * b;
        case "/": return b === 0 ? NaN : a / b;
        case "%": return b === 0 ? NaN : a % b;
        case "^": return Math.pow(a, b);
        default: throw new Error("Bad operator");
      }
    }
    case "fn": {
      const args = n.args.map(evalNode);
      return FUNCS[n.name].fn(...args);
    }
  }
}

export function computeExpr(expr: string): ComputeResult {
  const src = expr.trim().slice(0, 500);
  if (!src) return { ok: false, error: "Empty expression", expr };
  try {
    const ast = new Parser(src).parse();
    const v = evalNode(ast);
    if (!Number.isFinite(v)) return { ok: false, error: "Expression did not reduce to a finite number", expr };
    return { ok: true, value: v, expr };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Invalid expression", expr };
  }
}

export function fmtCompute(n: number): string {
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return n.toLocaleString("en-US");
  const abs = Math.abs(n);
  if (abs !== 0 && (abs < 1e-6 || abs >= 1e15)) return n.toExponential(4);
  return Number(n.toFixed(6)).toLocaleString("en-US", { maximumFractionDigits: 6 });
}

/** Regex to find [[COMPUTE ...]] directives in LLM output. */
export const COMPUTE_RE = /\[\[COMPUTE\s+([^\]]+?)\]\]/g;

/**
 * Replace every [[COMPUTE expr]] in text with the bold result, returning the
 * processed text and the computations performed (for activity events).
 */
export function processComputes(
  text: string,
): { text: string; computes: { expr: string; result: string; ok: boolean }[] } {
  const computes: { expr: string; result: string; ok: boolean }[] = [];
  const out = text.replace(COMPUTE_RE, (_m, expr: string) => {
    const r = computeExpr(expr);
    if (!r.ok) {
      computes.push({ expr, result: r.error || "error", ok: false });
      return `(compute error: ${r.error})`;
    }
    const result = fmtCompute(r.value);
    computes.push({ expr, result, ok: true });
    return `**${result}**`;
  });
  return { text: out, computes };
}
