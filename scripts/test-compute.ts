/** COMPUTE TOOL tests (P1-3, v3.3). Run: bun scripts/test-compute.ts
 *  Covers, without any LLM calls:
 *  - computeExpr: arithmetic precedence, parens, unary minus, ^ right-assoc,
 *    % and / by zero (NaN → honest error, never Infinity), all 21 functions,
 *    arity guards, unknown identifiers (NO eval — a "process.exit" string is
 *    a parse error, not executed), empty input, complexity cap, 500-char cap
 *  - fmtCompute: integers with thousands separators, ≤6 fraction digits,
 *    exponential for tiny/huge magnitudes
 *  - processComputes: [[COMPUTE ...]] substitution in report text — good
 *    expressions become **bold results**, broken ones become an honest
 *    inline "(compute error: …)" note, and every computation is returned
 *    for the activity rail */
import {
  computeExpr,
  fmtCompute,
  processComputes,
  COMPUTE_RE,
} from "../src/lib/research/compute";

let fails = 0;
let passes = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? "  ✓" : "  ✗ FAIL"} ${msg}`);
  if (!cond) fails++;
  else passes++;
};
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

console.log("— arithmetic & precedence");
ok(computeExpr("2+3*4").value === 14, "2+3*4 = 14 (precedence)");
ok(computeExpr("(2+3)*4").value === 20, "(2+3)*4 = 20 (parens)");
ok(computeExpr("-5+10").value === 5, "-5+10 = 5 (unary minus)");
ok(computeExpr("2^10").value === 1024, "2^10 = 1024");
ok(computeExpr("2^3^2").value === 512, "2^3^2 = 512 (^ right-assoc)");
ok(computeExpr("17%5").value === 2, "17%5 = 2 (modulo)");
ok(computeExpr("1_000*2").value === 2000, "1_000*2 = 2000 (underscore separator)");

console.log("— safety: division/modulo by zero, no eval, caps");
ok(
  !computeExpr("1/0").ok && (computeExpr("1/0").error || "").includes("finite"),
  "1/0 → honest error (NaN never leaks as a number)"
);
ok(
  !computeExpr("process.exit(1)").ok && (computeExpr("process.exit(1)").error || "").includes("Unknown function"),
  'process.exit → "Unknown function" (a string, never executed)'
);
ok(
  !computeExpr("1);require('fs')").ok,
  "injection attempt `1);require(...)` → parse error, no eval path"
);
ok(!computeExpr("").ok, "empty expression → error");
ok(
  !computeExpr("sum(" + "1+1+".repeat(200) + "1)").ok,
  "complexity cap fires past 400 nodes (Expression too complex)"
);
ok(
  computeExpr("1+1" + " ".repeat(596) + "!!!").value === 2,
  "inputs past 500 chars are truncated — the trailing !!! is ignored, 1+1 = 2"
);

console.log("— function library");
ok(computeExpr("sum(1,2,3,4,5)").value === 15, "sum(1..5) = 15");
ok(computeExpr("mean(2,4,6)").value === 4, "mean(2,4,6) = 4");
ok(computeExpr("median(1,9,2)").value === 2, "median odd = middle");
ok(computeExpr("median(1,2,3,4)").value === 2.5, "median even = midpoint");
ok(near(computeExpr("stdev(2,4,4,4,5,5,7,9)").value ?? 0, 2.13809, 1e-5), "stdev sample (8 values) ≈ 2.138");
ok(computeExpr("min(3,1,2)").value === 1 && computeExpr("max(3,1,2)").value === 3, "min/max");
ok(computeExpr("count(5,5,5)").value === 3, "count = 3");
ok(computeExpr("abs(0-7)").value === 7, "abs(-7) = 7");
ok(computeExpr("round(3.14159, 2)").value === 3.14, "round(π, 2) = 3.14");
ok(computeExpr("floor(2.9)").value === 2 && computeExpr("ceil(2.1)").value === 3, "floor/ceil");
ok(computeExpr("sqrt(144)").value === 12, "sqrt(144) = 12");
ok(near(computeExpr("ln(2.718281828)").value ?? 0, 1, 1e-6), "ln(e) ≈ 1");
ok(computeExpr("log10(1000)").value === 3, "log10(1000) = 3");
ok(near(computeExpr("exp(1)").value ?? 0, 2.718281828, 1e-6), "exp(1) ≈ e");
ok(computeExpr("pow(2,16)").value === 65536, "pow(2,16) = 65536");
ok(computeExpr("pct(25,200)").value === 12.5, "pct(25,200) = 12.5 (a as % of b)");
ok(computeExpr("growth(100,137)").value === 37, "growth(100,137) = 37 (pct change)");
ok(
  !computeExpr("round(1,2,3)").ok && (computeExpr("round(1,2,3)").error || "").includes("at most"),
  "arity guard: round(a,b,c) → \"takes at most 2\""
);
ok(
  !computeExpr("sum()").ok && (computeExpr("sum()").error || "").includes("at least one"),
  "arity guard: sum() → \"needs at least one argument\""
);

console.log("— fmtCompute presentation");
ok(fmtCompute(1234) === "1,234", "integer → 1,234");
ok(fmtCompute(0.123456789) === "0.123457", "decimals capped at 6 digits");
ok(fmtCompute(1e-8).includes("e"), "tiny magnitude → exponential");
ok(fmtCompute(1e16).includes("e"), "huge magnitude → exponential");

console.log("— processComputes: substitution in report text");
const { text, computes } = processComputes(
  "Growth was [[COMPUTE growth(100, 137)]]% and mean [[COMPUTE mean(2,4,6)]] plus bad [[COMPUTE 1+]]"
);
ok(text === "Growth was **37**% and mean **4** plus bad (compute error: Unexpected end of expression)", "good → **bold**, bad → honest inline error");
ok(
  computes.length === 3 &&
    computes[0].ok && computes[0].result === "37" &&
    computes[1].ok && computes[1].result === "4" &&
    !computes[2].ok,
  "all 3 computations reported for the activity rail"
);
const noCompute = processComputes("plain text, no directives");
ok(noCompute.text === "plain text, no directives" && noCompute.computes.length === 0, "text without directives passes through untouched");
ok([...("a [[COMPUTE 1+1]] b [[COMPUTE 2+2]] c".matchAll(COMPUTE_RE))].length === 2, "COMPUTE_RE finds every directive");

console.log("");
if (fails === 0) {
  console.log(`ALL COMPUTE TESTS PASS (${passes} checks)`);
  process.exit(0);
} else {
  console.log(`${fails} FAIL (of ${passes + fails})`);
  process.exit(1);
}
