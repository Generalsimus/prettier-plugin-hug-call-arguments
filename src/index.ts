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

const { group, conditionalGroup, indent, hardline, join, breakParent } =
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
  property?: ESNode;
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
 * Like Prettier's internal `couldExpandArg`, but also looks through calls
 * that merely wrap a huggable function, e.g. `catchAsync(async () => {})`.
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

  const lastArg = args.at(-1);
  if (
    !lastArg ||
    hasComment(lastArg) ||
    lastArg.type !== "CallExpression" ||
    lastArg.optional ||
    !lastArg.arguments ||
    lastArg.arguments.length === 0 ||
    !couldExpandArg(lastArg)
  ) {
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
  const headDocs = printedArgs.slice(0, -1);
  const lastDoc = printedArgs.at(-1);

  // If the earlier args don't fit on one line, or the wrapped callback
  // wouldn't break anyway, Prettier's default output is already fine.
  if (
    lastDoc === undefined ||
    headDocs.some((doc) => willBreak(doc)) ||
    !willBreak(lastDoc)
  ) {
    return undefined;
  }

  const headWithCommas = headDocs.flatMap((doc): Doc[] => [doc, ", "]);
  const trailingComma = options.trailingComma === "all" ? "," : "";

  const allArgsBrokenOut = (): Doc =>
    group(
      [
        "(",
        indent([hardline, join([",", hardline], printedArgs)]),
        trailingComma,
        hardline,
        ")",
      ],
      { shouldBreak: true },
    );

  return [
    breakParent,
    print("callee"),
    conditionalGroup([
      ["(", ...headWithCommas, group(lastDoc, { shouldBreak: true }), ")"],
      allArgsBrokenOut(),
    ]),
  ];
}

// A single `.method(args)` segment of a flattened call chain.
interface ChainLink {
  name: string;
  argsDocs: Doc[];
}

const MAX_CHAIN_LINKS = 6;

/**
 * Walks down `node.callee.object` as long as it's a plain, non-computed,
 * non-optional `.name(...)` call, printing each link's arguments along the
 * way. Returns `undefined` the moment anything doesn't match that shape
 * (computed access, optional chaining, generics, comments, spread callee,
 * ...), so the caller can safely fall back to Prettier's own chain printer.
 */
function collectChainLinks(
  path: AstPath<ESNode>,
  print: PrintFn,
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
    callee.computed ||
    callee.optional ||
    hasComment(callee)
  ) {
    return undefined;
  }

  const { property } = callee;
  if (!property || property.type !== "Identifier" || hasComment(property)) {
    return undefined;
  }

  const link: ChainLink = {
    name: property.name ?? "",
    argsDocs: path.map(print, "arguments"),
  };

  const { object } = callee;
  if (!object || hasComment(object)) {
    return undefined;
  }

  if (object.type === "CallExpression") {
    const inner = path.call(
      (innerPath) => collectChainLinks(innerPath, print, depth + 1),
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
 * Prettier's own doc printer doesn't reliably re-check `printWidth` for
 * plain content that comes *after* a forced break inside a conditionalGroup
 * alternative — this is the same class of limitation their own
 * `isHopefullyShortCallArgument` hack works around (see
 * https://github.com/prettier/prettier/issues/2456). So rather than trust
 * `conditionalGroup` to reject an overflowing flat chain on its own, render
 * the candidate standalone and check every line ourselves.
 */
function fitsWhenFlattened(doc: Doc, options: ParserOptions<ESNode>): boolean {
  const { formatted } = printer.printDocToString(doc, options);
  return formatted
    .split("\n")
    .every((line) => line.length <= options.printWidth);
}

/**
 * Handles method chains like `db.updateTable("User").set({ ... }).where(
 * "id", "=", user.id).execute()`, where Prettier's default chain printer
 * breaks every `.method()` onto its own line as soon as one argument (here
 * the object passed to `.set`) doesn't fit. When exactly one link in the
 * chain needs to break and the rest are short, this keeps the chain flat and
 * only lets that one argument expand — falling back to Prettier's own
 * chain layout (via `conditionalGroup`) if the flat version doesn't fit.
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
    node.callee.computed ||
    !node.callee.object ||
    node.callee.object.type !== "CallExpression"
  ) {
    return undefined;
  }

  const collected = collectChainLinks(path, print, 0);
  if (!collected || collected.links.length < 2) {
    return undefined;
  }
  const { links, baseDoc } = collected;

  const breakingLinks = links.filter((link) =>
    link.argsDocs.some((doc) => willBreak(doc)),
  );
  if (breakingLinks.length !== 1) {
    return undefined;
  }

  const flatDoc: Doc = [
    baseDoc,
    ...links.map((link): Doc => {
      const joinedArgs = link.argsDocs.flatMap((doc, index): Doc[] =>
        index === 0 ? [doc] : [", ", doc],
      );
      return [".", link.name, "(", ...joinedArgs, ")"];
    }),
  ];

  if (!fitsWhenFlattened(flatDoc, options)) {
    return undefined;
  }

  return [breakParent, flatDoc];
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
