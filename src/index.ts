// Fixes https://github.com/prettier/prettier/issues/11080
//
// Prettier "hugs" the last argument of a call and keeps the earlier
// arguments on the opening line when the last argument is itself a
// function/object/array literal, e.g.:
//
//   app.get("/x", (req, res) => {
//     ...
//   });
//
// But it refuses to do that when the last argument is a *call* that wraps
// such a literal, e.g. Express-style middleware wrappers:
//
//   app.delete("/campgrounds/:id", catchAsync(async (req, res) => {
//     ...
//   }));
//
// In that case Prettier falls back to breaking every argument onto its own
// line. This plugin extends the "can this be hugged" check to look through
// one or more wrapping calls, and reproduces Prettier's own hugging layout
// for that case. Every other case is delegated to the original estree
// printer, untouched.

import type { AstPath, Doc, ParserOptions, Plugin, Printer } from "prettier";
import { builders, printer, utils } from "prettier/doc";
// `prettier/plugins/estree` ships CommonJS + ESM builds; the CJS build is
// what `require`/interop resolves to, and its printer object is what we
// spread and delegate to for every node we don't special-case.
import * as estree from "prettier/plugins/estree";

const {
  group,
  indent,
  line,
  softline,
  hardline,
  join,
  ifBreak,
  breakParent,
  conditionalGroup,
} = builders;
const { willBreak } = utils;

// `estree.printers.estree` is typed as `Printer<any>` by Prettier, which is
// assignable to `Printer<ESNode>` on its own — no cast needed.
const estreePrinter: Printer<ESNode> = estree.printers.estree;

/**
 * Minimal structural view of the ESTree/Babel nodes this plugin touches.
 *
 * `callee` and `object` are declared as required so `AstPath#call` can chain
 * through them (`path.call(fn, "callee", "object")`) without the type
 * collapsing to `never` — see https://github.com/microsoft/TypeScript's
 * handling of `keyof (T | undefined)`. Every real read of these fields is
 * still guarded by a runtime truthiness check, since plenty of node types
 * don't actually have them.
 */
interface ESNode {
  type: string;
  comments?: unknown[];
  optional?: boolean;
  computed?: boolean;
  typeArguments?: unknown;
  typeParameters?: unknown;
  callee: ESNode;
  object: ESNode;
  property: ESNode;
  name?: string;
  arguments?: ESNode[];
  body?: ESNode;
  params?: ESNode[];
  async?: boolean;
  returnType?: unknown;
  predicate?: unknown;
  elements?: ESNode[];
  properties?: ESNode[];
  test?: ESNode;
  consequent?: ESNode;
  alternate?: ESNode;
}

function hasComment(node: ESNode | undefined | null): boolean {
  return Boolean(node?.comments && node.comments.length > 0);
}

/**
 * The terminal thing worth hugging at the bottom of a chain of wrapping
 * calls: a function (the common `catchAsync(cb)` case), or a plain
 * object/array literal directly (e.g. `firstValueFrom(client.getX({ ... }))`
 * — the object isn't itself wrapped in a function, but it's exactly what
 * Prettier would hug directly if it were the argument of a plain, unwrapped
 * call).
 */
function isHuggableLiteral(node: ESNode | undefined | null): boolean {
  if (!node) {
    return false;
  }
  if (node.type === "FunctionExpression") {
    return true;
  }
  if (node.type === "ArrowFunctionExpression") {
    const body = node.body;
    return (
      body?.type === "BlockStatement" ||
      body?.type === "ObjectExpression" ||
      body?.type === "ArrayExpression"
    );
  }
  return node.type === "ObjectExpression" || node.type === "ArrayExpression";
}

/**
 * A short, unbreakable-looking companion argument — the kind lodash-style
 * `uniqueBy(collection, iteratee)` APIs take alongside the huggable
 * collection argument. Deliberately conservative: only literals and plain
 * identifiers qualify, so this plugin never has to guess whether some
 * arbitrary expression will break.
 */
function isSimpleArg(node: ESNode | undefined | null): boolean {
  if (!node || hasComment(node)) {
    return false;
  }
  return (
    node.type === "StringLiteral" ||
    node.type === "NumericLiteral" ||
    node.type === "BooleanLiteral" ||
    node.type === "NullLiteral" ||
    node.type === "Identifier" ||
    node.type === "TemplateLiteral"
  );
}

/**
 * Like Prettier's internal `couldExpandArg`, but also looks through calls
 * that merely wrap a huggable function, e.g. `catchAsync(async () => {})`.
 * Only ever looks through the *last* argument, arbitrarily deep — so a chain
 * of wrappers like `a(b(c(cb)))` is still found. Deliberately does *not*
 * also recurse through the lodash-style "first argument wraps, second is
 * simple" shape here: that's only applied at the top, in
 * `findExpandableArgIndex`, for the call actually being printed. Letting it
 * recurse here would also make an *outer* call think it should hug a
 * wrapper two levels down, forcing everything onto one line with no way to
 * tell whether that line will actually fit once it's for real embedded
 * after an assignment, an `await`, or another wrapping call — see
 * `fitsWhenFlattened`'s column-0 blind spot below.
 */
function couldExpandArg(node: ESNode | undefined | null, depth = 0): boolean {
  if (!node || depth > 4) {
    return false;
  }
  if (isHuggableLiteral(node)) {
    return true;
  }
  if (
    node.type === "CallExpression" &&
    !node.optional &&
    !hasComment(node) &&
    node.arguments &&
    node.arguments.length > 0 &&
    !node.typeArguments &&
    !node.typeParameters
  ) {
    return couldExpandArg(node.arguments.at(-1), depth + 1);
  }
  return false;
}

/**
 * Finds which argument of a call is the one worth hugging: the last
 * argument when it's itself a wrapping call that leads to something
 * huggable, or — for a 2-argument call whose second argument is short and
 * simple — the first argument instead. Returns `undefined` when neither
 * shape matches, so the caller falls back to Prettier's default printing.
 */
function findExpandableArgIndex(args: ESNode[]): number | undefined {
  const isWrappingCall = (arg: ESNode | undefined): boolean =>
    arg !== undefined &&
    !hasComment(arg) &&
    arg.type === "CallExpression" &&
    !arg.optional &&
    Boolean(arg.arguments) &&
    (arg.arguments?.length ?? 0) > 0 &&
    couldExpandArg(arg);

  const last = args.at(-1);
  if (isWrappingCall(last)) {
    return args.length - 1;
  }

  if (args.length === 2) {
    const [first, second] = args;
    if (isWrappingCall(first) && isSimpleArg(second)) {
      return 0;
    }
  }

  return undefined;
}

/**
 * Only intervene for plain-looking callees (`foo(...)`, `a.b.c(...)`) so we
 * never fight Prettier's member/call-chain printing (`a().b().c(cb)`).
 */
function isSimpleCallee(callee: ESNode): boolean {
  if (
    callee.type === "Identifier" ||
    callee.type === "ThisExpression" ||
    callee.type === "Super"
  ) {
    return true;
  }
  if (callee.type === "MemberExpression" && !callee.computed && callee.object) {
    return isSimpleCallee(callee.object);
  }
  return false;
}

function hasBlankLineBetween(
  originalText: string,
  start: number,
  end: number,
): boolean {
  return /\n[^\S\n]*\n/.test(originalText.slice(start, end));
}

/**
 * `willBreak` only sees *forced* breaks (a hardline, or a group Prettier
 * already marked `shouldBreak: true` — e.g. an object literal whose first
 * property was already on its own line in the source, via `objectWrap:
 * "preserve"`). A conditional break — an object written on one line that's
 * simply too long to fit — has neither, so `willBreak` misses it. Render the
 * doc standalone and check whether it needed more than one line instead.
 * This only decides *how many* links look like they'll break for our own
 * "exactly one" heuristic; the actual safety net against overflow is
 * `fitsWhenFlattened`, which measures the real assembled doc.
 */
function wouldBreakStandalone(doc: Doc, options: ParserOptions<ESNode>): boolean {
  if (willBreak(doc)) {
    return true;
  }
  return printer.printDocToString(doc, options).formatted.includes("\n");
}

/**
 * Prettier's own doc printer doesn't reliably re-check `printWidth` for
 * plain content that comes *after* a forced break inside a conditionalGroup
 * alternative — this is the same class of limitation their own
 * `isHopefullyShortCallArgument` hack works around (see
 * https://github.com/prettier/prettier/issues/2456). So rather than trust
 * `conditionalGroup` to reject an overflowing candidate on its own, render it
 * standalone and check every line ourselves.
 */
/**
 * Prettier's own member/call-chain printer makes its "should I break at the
 * dots" decision using context (the surrounding call, the real column) this
 * plugin's manually-reconstructed docs don't provide when they print a
 * callee in isolation via `print("callee")` — which can make a callee that
 * vanilla Prettier would never break on its own (see the linked issue)
 * break at its dots anyway once disconnected from that context. Rendering
 * it standalone at an effectively unlimited width and using the resulting
 * plain text instead sidesteps the whole problem: nothing left to make that
 * decision differently. If something still forces a real break even at
 * unlimited width (a comment, most likely), this returns `undefined` and
 * the caller should bail rather than risk it.
 */
function renderFlatOrUndefined(
  doc: Doc,
  options: ParserOptions<ESNode>,
): Doc | undefined {
  const { formatted } = printer.printDocToString(doc, {
    ...options,
    printWidth: Number.MAX_SAFE_INTEGER,
  });
  return formatted.includes("\n") ? undefined : formatted;
}

/**
 * Prettier's own doc printer doesn't reliably re-check `printWidth` for
 * plain content that comes *after* a forced break inside a conditionalGroup
 * alternative — this is the same class of limitation their own
 * `isHopefullyShortCallArgument` hack works around (see
 * https://github.com/prettier/prettier/issues/2456). So rather than trust
 * `conditionalGroup` to reject an overflowing candidate on its own, render it
 * standalone and check every line ourselves.
 */
function fitsWhenFlattened(doc: Doc, options: ParserOptions<ESNode>): boolean {
  const { formatted } = printer.printDocToString(doc, options);
  return formatted
    .split("\n")
    .every((line) => line.length <= options.printWidth);
}

type PrintFn = (
  selector?: string | number | Array<string | number> | AstPath<ESNode>,
  args?: unknown,
) => Doc;

type ListKind = "call" | "array" | "params" | "object";

function getTrailingComma(
  options: ParserOptions<ESNode>,
  kind: ListKind,
): string {
  if (options.trailingComma === "all") {
    return ",";
  }
  if (
    options.trailingComma === "es5" &&
    (kind === "array" || kind === "object")
  ) {
    return ",";
  }
  return "";
}

/**
 * How the author laid out a list's *own* separators in the source:
 * "multiline" when there's a newline right after the opening bracket,
 * between any two items, or right before the closing bracket; "inline"
 * otherwise. Newlines *inside* an item never count — every list (and every
 * nested list inside its items) decides for itself, independently.
 */
type ListLayout = "multiline" | "inline";

/**
 * Returns `undefined` when the brackets can't be located reliably (sparse
 * array, comments, unexpected source shape), so the caller can bail.
 */
function detectListLayout(
  options: ParserOptions<ESNode>,
  items: Array<ESNode | null | undefined>,
  openIndex: number,
  closeChar: string,
): ListLayout | undefined {
  const text = options.originalText;
  if (
    items.length === 0 ||
    openIndex === -1 ||
    items.some((item) => !item || hasComment(item))
  ) {
    return undefined;
  }
  const nodes = items as ESNode[];
  const first = nodes[0] as ESNode;
  const last = nodes.at(-1) as ESNode;
  if (openIndex >= options.locStart(first)) {
    return undefined;
  }

  // Skip whitespace and an optional trailing comma to reach the bracket.
  let closeIndex = options.locEnd(last);
  while (closeIndex < text.length && /[\s,]/.test(text.charAt(closeIndex))) {
    closeIndex++;
  }
  if (text.charAt(closeIndex) !== closeChar) {
    return undefined;
  }

  const gaps: Array<[number, number]> = [
    [openIndex + 1, options.locStart(first)],
  ];
  for (let i = 0; i < nodes.length - 1; i++) {
    gaps.push([
      options.locEnd(nodes[i] as ESNode),
      options.locStart(nodes[i + 1] as ESNode),
    ]);
  }
  gaps.push([options.locEnd(last), closeIndex]);

  return gaps.some(([start, end]) => text.slice(start, end).includes("\n"))
    ? "multiline"
    : "inline";
}

/**
 * The layout of a call's own argument list, as written in the source.
 */
function detectCallArgsLayout(
  node: ESNode,
  options: ParserOptions<ESNode>,
): ListLayout | undefined {
  if (
    node.type !== "CallExpression" ||
    node.typeArguments ||
    node.typeParameters ||
    !node.callee
  ) {
    return undefined;
  }
  const openIndex = options.originalText.indexOf(
    "(",
    options.locEnd(node.callee),
  );
  return detectListLayout(options, node.arguments ?? [], openIndex, ")");
}

/**
 * Either one item per line (`multiline`), or every item on the opening
 * line separated by `, ` (`inline`) — in which case an item that itself
 * needs several lines (a nested list the author broke, a function body)
 * breaks on its own, without dragging the rest of this list with it.
 */
function buildListDoc(
  openChar: string,
  closeChar: string,
  itemDocs: Doc[],
  layout: ListLayout,
  trailingComma: string,
  padding = "",
): Doc {
  if (layout === "multiline") {
    return [
      openChar,
      indent([hardline, join([",", hardline], itemDocs), trailingComma]),
      hardline,
      closeChar,
    ];
  }
  return [openChar, padding, join(", ", itemDocs), padding, closeChar];
}

/**
 * Respects how the author laid out a list's own items, for call arguments,
 * array elements, object properties and arrow function parameters:
 *
 * - A newline anywhere between the list's own items (or right inside its
 *   brackets) means "one item per line" — kept even if it would fit on one
 *   line. Prettier already does a narrower version of this for objects
 *   (`objectWrap: "preserve"`, newline before the first key only).
 * - No such newline, but an item that itself needs several lines: the list
 *   stays on its opening line and only that item breaks, e.g.
 *   `foo([\n  1,\n  2,\n], b)` — instead of Prettier's default of breaking
 *   every item out once any one of them breaks. This falls back to
 *   Prettier's own layout when even the opening line wouldn't fit.
 * - Otherwise (nothing breaks), Prettier's own width-based layout applies.
 *
 * Only newlines between this list's *own* items count; a newline inside
 * an item belongs to that item, which decides its own layout the same way.
 *
 * Bails on anything that would make locating the brackets or reproducing
 * the layout unsafe: comments anywhere in the list, a sparse array, or
 * (for calls) TS type arguments.
 */
function tryRespectListLayout(
  path: AstPath<ESNode>,
  options: ParserOptions<ESNode>,
  print: PrintFn,
  kind: ListKind,
  printFallback: () => Doc,
): Doc | undefined {
  const { node } = path;

  let items: ESNode[];
  let openChar: "(" | "[" | "{";
  let closeChar: ")" | "]" | "}";
  let openIndex: number;
  let prefixDoc: Doc = "";
  let suffixDoc: Doc = "";
  let padding = "";
  let printItems: () => Doc[];

  if (kind === "call") {
    if (
      node.type !== "CallExpression" ||
      node.optional ||
      node.typeArguments ||
      node.typeParameters ||
      !node.callee ||
      !isSimpleCallee(node.callee) ||
      // Let chain-flattening handle the outermost call of a chain instead —
      // this only steps in for a plain, non-chained call.
      (node.callee.type === "MemberExpression" &&
        node.callee.object?.type === "CallExpression")
    ) {
      return undefined;
    }
    items = node.arguments ?? [];
    openChar = "(";
    closeChar = ")";
    openIndex = options.originalText.indexOf("(", options.locEnd(node.callee));
    prefixDoc = print("callee");
    printItems = () => path.map(print, "arguments");
  } else if (kind === "array") {
    if (node.type !== "ArrayExpression") {
      return undefined;
    }
    items = node.elements ?? [];
    openChar = "[";
    closeChar = "]";
    openIndex = options.locStart(node);
    printItems = () => path.map(print, "elements");
  } else if (kind === "object") {
    if (node.type !== "ObjectExpression") {
      return undefined;
    }
    items = node.properties ?? [];
    openChar = "{";
    closeChar = "}";
    openIndex = options.locStart(node);
    padding = options.bracketSpacing ? " " : "";
    printItems = () => path.map(print, "properties");
  } else {
    // Arrow functions only — a plain `function` expression/declaration also
    // has a name and a block body to reproduce, which is more than this
    // narrow check is worth taking on.
    if (
      node.type !== "ArrowFunctionExpression" ||
      node.typeParameters ||
      node.returnType ||
      node.predicate ||
      !node.body ||
      hasComment(node.body)
    ) {
      return undefined;
    }
    items = node.params ?? [];
    openChar = "(";
    closeChar = ")";
    openIndex = options.originalText.indexOf("(", options.locStart(node));
    prefixDoc = node.async ? "async " : "";
    suffixDoc = [" => ", print("body")];
    printItems = () => path.map(print, "params");
  }

  if (hasComment(node) || options.originalText.charAt(openIndex) !== openChar) {
    return undefined;
  }
  const layout = detectListLayout(options, items, openIndex, closeChar);
  if (
    layout === undefined ||
    // A single item on its own line isn't a "one per line" layout.
    (layout === "multiline" && items.length < 2) ||
    // Prettier already hugs object-pattern params etc. on its own.
    (layout === "inline" && kind === "params")
  ) {
    return undefined;
  }

  const itemDocs = printItems();
  if (layout === "inline" && !itemDocs.some((doc) => willBreak(doc))) {
    // Nothing forces a break — Prettier's own width-based layout is fine.
    return undefined;
  }

  if (kind === "call") {
    const flatPrefix = renderFlatOrUndefined(prefixDoc, options);
    if (flatPrefix === undefined) {
      return undefined;
    }
    prefixDoc = flatPrefix;
  }

  const listDoc = buildListDoc(
    openChar,
    closeChar,
    itemDocs,
    layout,
    getTrailingComma(options, kind),
    padding,
  );

  if (layout === "multiline") {
    return [breakParent, prefixDoc, listDoc, suffixDoc];
  }
  // Same mechanism Prettier uses to hug a last argument: a conditionalGroup
  // stops the inner break from propagating to (and breaking) this list
  // itself, while the outer breakParent still lets enclosing groups react.
  return [
    breakParent,
    conditionalGroup([[prefixDoc, listDoc, suffixDoc], printFallback()]),
  ];
}

/**
 * A ternary written on one line whose branch needs several lines (e.g. it
 * contains a list the author broke) stays on its line — `a ? foo([\n...\n])
 * : null` — instead of Prettier's default of moving `?` and `:` onto their
 * own lines. Same "the child's newlines are the child's business" rule as
 * `tryRespectListLayout`, and the same fallback when it wouldn't fit.
 */
function tryInlineConditional(
  path: AstPath<ESNode>,
  options: ParserOptions<ESNode>,
  print: PrintFn,
  printFallback: () => Doc,
): Doc | undefined {
  const { node } = path;
  const { test, consequent, alternate } = node;
  if (
    node.type !== "ConditionalExpression" ||
    hasComment(node) ||
    !test ||
    !consequent ||
    !alternate ||
    [test, consequent, alternate].some(hasComment)
  ) {
    return undefined;
  }
  const text = options.originalText;
  if (
    text
      .slice(options.locEnd(test), options.locStart(consequent))
      .includes("\n") ||
    text
      .slice(options.locEnd(consequent), options.locStart(alternate))
      .includes("\n")
  ) {
    return undefined;
  }

  const consequentDoc = print("consequent");
  const alternateDoc = print("alternate");
  if (!willBreak(consequentDoc) && !willBreak(alternateDoc)) {
    return undefined;
  }

  return [
    breakParent,
    conditionalGroup([
      [print("test"), " ? ", consequentDoc, " : ", alternateDoc],
      printFallback(),
    ]),
  ];
}

/**
 * A call with exactly one argument that's directly an object or array
 * literal — `getX({ ... })` — is already hugged reliably by Prettier on its
 * own, *in isolation*. But Prettier's own "hug the sole argument" mechanism
 * is still gated on whether the opening line fits at the real column, and
 * gives up (breaking the call's own parens too) when it doesn't — which
 * becomes very possible once this plugin has already fused several outer
 * layers together (e.g. `firstValueFrom(client.getX({ ... }))`, once
 * `firstValueFrom(...)` hugs, pushes `getX(`'s real column much deeper).
 * There's essentially never a readability win to giving up like that
 * instead of just hugging directly, so this always does — but, like the
 * plugin's other hugging features, only once the argument actually needs
 * multi-line printing; a short object/array that already fits is left
 * alone.
 */
function tryHugSoleLiteralArg(
  path: AstPath<ESNode>,
  options: ParserOptions<ESNode>,
  print: PrintFn,
): Doc | undefined {
  const { node } = path;

  if (
    node.type !== "CallExpression" ||
    node.optional ||
    node.typeArguments ||
    node.typeParameters ||
    !node.callee ||
    !isSimpleCallee(node.callee)
  ) {
    return undefined;
  }

  const args = node.arguments ?? [];
  const [only] = args;
  if (
    args.length !== 1 ||
    !only ||
    hasComment(only) ||
    (only.type !== "ObjectExpression" && only.type !== "ArrayExpression")
  ) {
    return undefined;
  }

  const argDoc = path.map(print, "arguments")[0];
  if (argDoc === undefined || !wouldBreakStandalone(argDoc, options)) {
    return undefined;
  }

  const calleeDoc = renderFlatOrUndefined(print("callee"), options);
  if (calleeDoc === undefined) {
    return undefined;
  }

  return [breakParent, calleeDoc, "(", argDoc, ")"];
}

function tryHugWrappedCallback(
  path: AstPath<ESNode>,
  options: ParserOptions<ESNode>,
  print: PrintFn,
): Doc | undefined {
  const { node } = path;

  if (node.type !== "CallExpression" || node.optional) {
    return undefined;
  }
  if (node.typeArguments || node.typeParameters) {
    return undefined;
  }

  const args = node.arguments ?? [];
  if (args.length === 0 || !node.callee || !isSimpleCallee(node.callee)) {
    return undefined;
  }

  const expandIndex = findExpandableArgIndex(args);
  if (expandIndex === undefined) {
    return undefined;
  }

  for (let i = 0; i < args.length - 1; i++) {
    const current = args[i];
    const next = args[i + 1];
    if (
      current &&
      next &&
      hasBlankLineBetween(
        options.originalText,
        options.locEnd(current),
        options.locStart(next),
      )
    ) {
      return undefined;
    }
  }

  const printedArgs = path.map(print, "arguments");
  const expandDoc = printedArgs[expandIndex];
  const otherDocs = printedArgs.filter((_, i) => i !== expandIndex);

  // If the other args don't fit on one line, or the wrapped callback
  // wouldn't break anyway, Prettier's default output is already fine.
  if (
    expandDoc === undefined ||
    otherDocs.some((doc) => wouldBreakStandalone(doc, options)) ||
    !wouldBreakStandalone(expandDoc, options)
  ) {
    return undefined;
  }

  const calleeDoc = renderFlatOrUndefined(print("callee"), options);
  if (calleeDoc === undefined) {
    return undefined;
  }

  const beforeDocs = printedArgs.slice(0, expandIndex);
  const afterDocs = printedArgs.slice(expandIndex + 1);
  const beforeWithCommas = beforeDocs.flatMap((doc): Doc[] => [doc, ", "]);
  const afterWithCommas = afterDocs.flatMap((doc): Doc[] => [", ", doc]);

  const primaryDoc: Doc = [
    calleeDoc,
    "(",
    ...beforeWithCommas,
    group(expandDoc, { shouldBreak: true }),
    ...afterWithCommas,
    ")",
  ];

  // Rendering this standalone starts it at column 0, blind to whatever real
  // prefix (an assignment, an `await`, an outer wrapping call) it's actually
  // embedded after — so this under-counts the true column and can pass a
  // candidate that will genuinely overflow once placed for real. It's still
  // the right conservative default: it correctly rejects the case that
  // matters most (this call's own head arguments are too long to share the
  // opening line), and erring toward Prettier's own default breakout is
  // always a safe fallback.
  if (!fitsWhenFlattened(primaryDoc, options)) {
    return undefined;
  }

  return [breakParent, primaryDoc];
}

/**
 * Handles an arrow function with a concise (non-block) body that's itself a
 * call needing multi-line printing, e.g.:
 *
 *   const f = (data: Job) => pgBoss.then((boss) => {
 *     ...
 *   });
 *
 * Prettier hugs a concise body directly after `=>` for several node types
 * (object/array literals, JSX, template literals, ...) but not for a plain
 * `CallExpression` — it always inserts a hardline after `=>` and indents the
 * call onto its own line instead, even when the call's own last argument is
 * already going to hug and break internally regardless. This reproduces
 * Prettier's own arrow-head printing for the narrow, common shape (no type
 * parameters, return type, or predicate; default `arrowParens`) and keeps
 * the body on the same line as `=>` instead.
 */
function tryHugArrowBody(
  path: AstPath<ESNode>,
  options: ParserOptions<ESNode>,
  print: PrintFn,
): Doc | undefined {
  const { node } = path;

  if (
    node.type !== "ArrowFunctionExpression" ||
    hasComment(node) ||
    node.typeParameters ||
    node.returnType ||
    node.predicate ||
    options.arrowParens === "avoid"
  ) {
    return undefined;
  }

  const body = node.body;
  if (!body || body.type !== "CallExpression" || hasComment(body)) {
    return undefined;
  }

  const bodyDoc = print("body");
  if (!wouldBreakStandalone(bodyDoc, options)) {
    return undefined;
  }

  const trailingComma = options.trailingComma === "all" ? "," : "";
  const paramsDoc = group([
    "(",
    indent([softline, join([",", line], path.map(print, "params"))]),
    ifBreak(trailingComma),
    softline,
    ")",
  ]);

  const primaryDoc: Doc = [
    node.async ? "async " : "",
    paramsDoc,
    " => ",
    bodyDoc,
  ];

  // Same column-0 blind spot as `tryHugWrappedCallback` (see its comment) —
  // conservative, but errs toward Prettier's own default when unsure.
  if (!fitsWhenFlattened(primaryDoc, options)) {
    return undefined;
  }

  return [breakParent, primaryDoc];
}

// A single `.name(args)` or `[expr](args)` segment of a flattened chain.
interface ChainLink {
  accessDoc: Doc;
  argsDoc: Doc;
}

const MAX_CHAIN_LINKS = 6;

/**
 * Builds the `(...)` doc for one link's argument list the same way a plain,
 * standalone call would print it: a single argument is hugged directly
 * against the parens (so an object/array still expands in place, e.g.
 * `.set({ ... })`, not indented as its own nested line); more than one
 * argument gets Prettier's normal "fits on one line, else one per line"
 * group. Either way the break decision is left to Prettier's regular,
 * width-aware group mechanics — not something this plugin pre-computes.
 *
 * The exception is the author's own layout, same as `tryRespectListLayout`:
 * arguments written one per line stay that way, and arguments written on
 * one line stay there when only one of them needs to break.
 */
function buildArgsDoc(
  argsDocs: Doc[],
  trailingComma: string,
  layout: ListLayout | undefined,
): Doc {
  if (argsDocs.length === 0) {
    return "()";
  }
  const [only] = argsDocs;
  if (argsDocs.length === 1 && only !== undefined) {
    return ["(", only, ")"];
  }
  if (layout === "multiline") {
    return buildListDoc("(", ")", argsDocs, layout, trailingComma);
  }
  if (layout === "inline" && argsDocs.some((doc) => willBreak(doc))) {
    return buildListDoc("(", ")", argsDocs, layout, trailingComma);
  }
  return group([
    "(",
    indent([softline, join([",", line], argsDocs)]),
    ifBreak(trailingComma),
    softline,
    ")",
  ]);
}

/**
 * Walks down `node.callee.object` as long as it's a plain, non-optional
 * `.name(...)` or `[expr](...)` call, printing each link's property access
 * and arguments along the way. Returns `undefined` the moment anything
 * doesn't match that shape (optional chaining, generics, comments, spread
 * callee, ...), so the caller can safely fall back to Prettier's own chain
 * printer.
 */
function collectChainLinks(
  path: AstPath<ESNode>,
  print: PrintFn,
  options: ParserOptions<ESNode>,
  depth: number,
): { links: ChainLink[]; baseDoc: Doc } | undefined {
  if (depth > MAX_CHAIN_LINKS) {
    return undefined;
  }

  const { node } = path;
  if (
    node.type !== "CallExpression" ||
    node.optional ||
    node.typeArguments ||
    node.typeParameters ||
    hasComment(node)
  ) {
    return undefined;
  }

  const { callee } = node;
  if (
    !callee ||
    callee.type !== "MemberExpression" ||
    callee.optional ||
    hasComment(callee)
  ) {
    return undefined;
  }

  const { property } = callee;
  if (!property || hasComment(property)) {
    return undefined;
  }

  let accessDoc: Doc;
  if (callee.computed) {
    accessDoc = ["[", path.call(print, "callee", "property"), "]"];
  } else if (property.type === "Identifier") {
    accessDoc = [".", property.name ?? ""];
  } else {
    return undefined;
  }

  const trailingComma = options.trailingComma === "all" ? "," : "";
  const link: ChainLink = {
    accessDoc,
    argsDoc: buildArgsDoc(
      path.map(print, "arguments"),
      trailingComma,
      detectCallArgsLayout(node, options),
    ),
  };

  const { object } = callee;
  if (!object || hasComment(object)) {
    return undefined;
  }

  if (object.type === "CallExpression") {
    const inner = path.call(
      (innerPath) => collectChainLinks(innerPath, print, options, depth + 1),
      "callee",
      "object",
    );
    return inner === undefined
      ? undefined
      : { links: [...inner.links, link], baseDoc: inner.baseDoc };
  }

  if (!isSimpleCallee(object)) {
    return undefined;
  }

  const baseDoc = path.call(print, "callee", "object");
  return { links: [link], baseDoc };
}

/**
 * Handles method chains like `db.updateTable("User").set({ ... }).where(
 * "id", "=", user.id).execute()`, where Prettier's default chain printer
 * breaks every `.method()` onto its own line as soon as any argument
 * doesn't fit. This instead keeps the whole chain flat — `.foo(...).bar(
 * ...).baz(...)` — and lets each link's own arguments break independently
 * if they need to, falling back to Prettier's normal chain layout only if
 * the flattened result doesn't fit the shape this plugin handles, or would
 * overflow `printWidth`.
 */
function tryHugChainArgument(
  path: AstPath<ESNode>,
  options: ParserOptions<ESNode>,
  print: PrintFn,
): Doc | undefined {
  const { node } = path;

  if (node.type !== "CallExpression" || node.optional) {
    return undefined;
  }
  // Only handle the outermost call of a chain — if this call is itself
  // being member-accessed further, let that outer node make the decision.
  if (path.parent?.type === "MemberExpression") {
    return undefined;
  }
  if (
    !node.callee ||
    node.callee.type !== "MemberExpression" ||
    !node.callee.object ||
    node.callee.object.type !== "CallExpression"
  ) {
    return undefined;
  }

  const collected = collectChainLinks(path, print, options, 0);
  if (!collected || collected.links.length < 2) {
    return undefined;
  }
  const { links, baseDoc } = collected;

  const flatDoc: Doc = [
    baseDoc,
    ...links.map((link): Doc => [link.accessDoc, link.argsDoc]),
  ];

  if (!fitsWhenFlattened(flatDoc, options)) {
    return undefined;
  }

  return willBreak(flatDoc) ? [breakParent, flatDoc] : flatDoc;
}

const plugin: Plugin<ESNode> = {
  printers: {
    estree: {
      ...estreePrinter,
      print(path, options, print, args) {
        const printDefault = (): Doc =>
          estreePrinter.print(path, options, print, args);
        const printHugged = (): Doc | undefined =>
          tryHugWrappedCallback(path, options, print) ??
          tryHugSoleLiteralArg(path, options, print) ??
          tryHugArrowBody(path, options, print) ??
          tryHugChainArgument(path, options, print);
        const printFallback = (): Doc => printHugged() ?? printDefault();

        // Respecting a layout the developer explicitly chose by hand takes
        // priority over this plugin's own hugging heuristics.
        const custom =
          tryRespectListLayout(path, options, print, "call", printFallback) ??
          tryRespectListLayout(path, options, print, "array", printFallback) ??
          tryRespectListLayout(path, options, print, "object", printFallback) ??
          tryRespectListLayout(path, options, print, "params", printFallback) ??
          tryInlineConditional(path, options, print, printFallback) ??
          printHugged();
        if (custom === undefined) {
          return printDefault();
        }
        // The estree printer adds required parentheses (e.g. an object
        // literal as an arrow body) itself, as an outer `["(", doc, ")"]` —
        // which a custom doc would otherwise silently drop.
        const defaultDoc = printDefault();
        return Array.isArray(defaultDoc) &&
          defaultDoc.length === 3 &&
          defaultDoc[0] === "(" &&
          defaultDoc[2] === ")"
          ? ["(", custom, ")"]
          : custom;
      },
    },
  },
};

export = plugin;
