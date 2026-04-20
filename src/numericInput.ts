// Tier 3 #8 — numeric formula inputs.
//
// Lets users type arithmetic expressions like `3+2`, `(20*1.1)`,
// `-12 / 2` in any `.num-input` cell. If the raw input only contains
// the safe charset (digits, decimal points, arithmetic operators,
// parentheses, whitespace) and evaluates to a finite number, we accept
// the expression's value; otherwise the caller falls through to the
// existing `Number(raw)` path.
//
// Pure function so the parser can be unit-tested without a DOM.
//
// Security posture: the charset whitelist at the top means the
// expression that hits the evaluator can only contain arithmetic
// tokens — no identifiers, no string literals, no property access,
// no function calls (parentheses are grouping only, there's no
// preceding identifier to apply them to). The evaluator itself is a
// small hand-rolled tokenizer + shunting-yard parser so no JS `eval` or
// `Function()` is involved. A malicious input is at worst a number —
// same attack surface as any `Number("…")` call.

const SAFE_EXPRESSION = /^[\d+\-*/.() \t]+$/;

type Token =
	| { type: "num"; value: number }
	| { type: "op"; value: "+" | "-" | "*" | "/" }
	| { type: "lparen" }
	| { type: "rparen" };

function tokenize(input: string): Token[] | null {
	const tokens: Token[] = [];
	let i = 0;
	while (i < input.length) {
		const ch = input[i];
		if (ch === " " || ch === "\t") {
			i++;
			continue;
		}
		if (ch === "(") {
			tokens.push({ type: "lparen" });
			i++;
			continue;
		}
		if (ch === ")") {
			tokens.push({ type: "rparen" });
			i++;
			continue;
		}
		if (ch === "+" || ch === "*" || ch === "/") {
			tokens.push({ type: "op", value: ch });
			i++;
			continue;
		}
		// `-` is either a binary operator or a unary sign. Disambiguate
		// from the previous token: unary when the previous slot is
		// empty / an operator / a left paren.
		if (ch === "-") {
			const prev = tokens[tokens.length - 1];
			const isUnary = !prev || prev.type === "op" || prev.type === "lparen";
			if (isUnary) {
				// Swallow into the next number literal below.
				let j = i + 1;
				// Skip whitespace between the sign and the number.
				while (j < input.length && (input[j] === " " || input[j] === "\t"))
					j++;
				const start = j;
				while (
					j < input.length &&
					(/[0-9.]/.test(input[j]))
				) {
					j++;
				}
				if (j === start) return null;
				const num = Number(`-${input.slice(start, j)}`);
				if (!Number.isFinite(num)) return null;
				tokens.push({ type: "num", value: num });
				i = j;
				continue;
			}
			tokens.push({ type: "op", value: "-" });
			i++;
			continue;
		}
		if (/[0-9.]/.test(ch)) {
			const start = i;
			while (i < input.length && /[0-9.]/.test(input[i])) i++;
			const num = Number(input.slice(start, i));
			if (!Number.isFinite(num)) return null;
			tokens.push({ type: "num", value: num });
			continue;
		}
		// Any other character should have been blocked by SAFE_EXPRESSION.
		return null;
	}
	return tokens;
}

// Shunting-yard → RPN → evaluate. Arithmetic only; precedence: */ above +−.
function evaluate(tokens: Token[]): number | null {
	const output: Token[] = [];
	const operators: Token[] = [];
	const prec: Record<string, number> = { "+": 1, "-": 1, "*": 2, "/": 2 };
	for (const t of tokens) {
		if (t.type === "num") {
			output.push(t);
		} else if (t.type === "op") {
			while (operators.length) {
				const top = operators[operators.length - 1];
				if (top.type === "op" && prec[top.value] >= prec[t.value]) {
					output.push(operators.pop() as Token);
				} else {
					break;
				}
			}
			operators.push(t);
		} else if (t.type === "lparen") {
			operators.push(t);
		} else if (t.type === "rparen") {
			while (operators.length) {
				const top = operators[operators.length - 1];
				if (top.type === "lparen") {
					operators.pop();
					break;
				}
				output.push(operators.pop() as Token);
			}
		}
	}
	while (operators.length) {
		const op = operators.pop() as Token;
		if (op.type === "lparen" || op.type === "rparen") return null;
		output.push(op);
	}

	const stack: number[] = [];
	for (const t of output) {
		if (t.type === "num") {
			stack.push(t.value);
			continue;
		}
		if (t.type === "op") {
			const b = stack.pop();
			const a = stack.pop();
			if (a === undefined || b === undefined) return null;
			let r: number;
			switch (t.value) {
				case "+":
					r = a + b;
					break;
				case "-":
					r = a - b;
					break;
				case "*":
					r = a * b;
					break;
				case "/":
					if (b === 0) return null;
					r = a / b;
					break;
			}
			stack.push(r);
			continue;
		}
		return null;
	}
	if (stack.length !== 1) return null;
	const result = stack[0];
	return Number.isFinite(result) ? result : null;
}

export function evaluateNumericInput(raw: string): number | null {
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim();
	if (!trimmed) return null;
	if (!SAFE_EXPRESSION.test(trimmed)) return null;
	// Simple bare numbers — cheap fast path.
	if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
		const n = Number(trimmed);
		return Number.isFinite(n) ? n : null;
	}
	const tokens = tokenize(trimmed);
	if (!tokens || tokens.length === 0) return null;
	return evaluate(tokens);
}
