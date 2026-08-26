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

const { group, indent, line, softline, join, ifBreak, breakParent } =
  builders;
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
  start?: number;
  end?: number;
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
}

function hasComment(node: ESNode | undefined | null): boolean {
  return Boolean(node?.comments && node.comments.length > 0);
}

function isHuggableFunction(node: ESNode | undefined | null): boolean {
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
  return false;
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
  if (isHuggableFunction(node)) {
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
      current?.end !== undefined &&
      next?.start !== undefined &&
      hasBlankLineBetween(options.originalText, current.end, next.start)
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

  const beforeDocs = printedArgs.slice(0, expandIndex);
  const afterDocs = printedArgs.slice(expandIndex + 1);
  const beforeWithCommas = beforeDocs.flatMap((doc): Doc[] => [doc, ", "]);
  const afterWithCommas = afterDocs.flatMap((doc): Doc[] => [", ", doc]);

  const primaryDoc: Doc = [
    print("callee"),
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
 */
function buildArgsDoc(argsDocs: Doc[], trailingComma: string): Doc {
  if (argsDocs.length === 0) {
    return "()";
  }
  const [only] = argsDocs;
  if (argsDocs.length === 1 && only !== undefined) {
    return ["(", only, ")"];
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
    argsDoc: buildArgsDoc(path.map(print, "arguments"), trailingComma),
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
        const hugged =
          tryHugWrappedCallback(path, options, print) ??
          tryHugChainArgument(path, options, print);
        return hugged === undefined
          ? estreePrinter.print(path, options, print, args)
          : hugged;
      },
    },
  },
};

export = plugin;
