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
import { builders, utils } from "prettier/doc";
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

/** Minimal structural view of the ESTree/Babel nodes this plugin touches. */
interface ESNode {
  type: string;
  start?: number;
  end?: number;
  comments?: unknown[];
  optional?: boolean;
  computed?: boolean;
  typeArguments?: unknown;
  typeParameters?: unknown;
  callee?: ESNode;
  object?: ESNode;
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

const plugin: Plugin<ESNode> = {
  printers: {
    estree: {
      ...estreePrinter,
      print(path, options, print, args) {
        const hugged = tryHugWrappedCallback(path, options, print);
        return hugged === undefined
          ? estreePrinter.print(path, options, print, args)
          : hugged;
      },
    },
  },
};

export = plugin;
