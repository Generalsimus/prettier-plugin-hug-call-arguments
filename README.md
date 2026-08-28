# prettier-plugin-hug-call-arguments

[![license][license-src]][license-href]
[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![CI][ci-src]][ci-href]

[license-src]: https://img.shields.io/badge/license-MIT-brightgreen?&style=flat-square
[license-href]: https://github.com/Generalsimus/prettier-plugin-hug-call-arguments/blob/main/LICENSE
[npm-version-src]: https://img.shields.io/npm/v/prettier-plugin-hug-call-arguments?&style=flat-square&logo=npm&logoColor=white&color=CB3837
[npm-version-href]: https://www.npmjs.com/package/prettier-plugin-hug-call-arguments
[npm-downloads-src]: https://img.shields.io/npm/dt/prettier-plugin-hug-call-arguments?&style=flat-square&logo=npm&logoColor=white&color=CB3837
[npm-downloads-href]: https://www.npmjs.com/package/prettier-plugin-hug-call-arguments
[ci-src]: https://img.shields.io/github/actions/workflow/status/Generalsimus/prettier-plugin-hug-call-arguments/test.yml?branch=main&&style=flat-square
[ci-href]: https://github.com/Generalsimus/prettier-plugin-hug-call-arguments/actions/workflows/test.yml

Fixes [prettier/prettier#11080](https://github.com/prettier/prettier/issues/11080).

## Usage

Requires Prettier 3.x as a peer dependency.

```sh
npm install --save-dev prettier-plugin-hug-call-arguments
```

```sh
yarn add --dev prettier-plugin-hug-call-arguments
```

```sh
pnpm add --save-dev prettier-plugin-hug-call-arguments
```

Add it to your Prettier config (`.prettierrc`, `.prettierrc.json`,
`prettier.config.js`, or the `"prettier"` key in `package.json`):

```json
{
  "plugins": ["prettier-plugin-hug-call-arguments"]
}
```

No other options — it works automatically wherever Prettier already formats
JS/JSX/TS/TSX with the `estree` printer (the `babel`, `babel-ts`, and
`typescript` parsers). Nothing to configure, and every case it doesn't
recognize is left to Prettier's own formatting untouched.

## Examples

Prettier hugs the last argument of a call when it's a function/object/array
literal:

```js
app.get("/x", (req, res) => {
  res.send("ok");
});
```

...but not when that literal is wrapped in another call, which is a very
common pattern for middleware wrappers (Express `catchAsync`, error
boundaries, decorators-as-functions, etc.):

```js
// input
app.delete('/campgrounds/:id', catchAsync(async (req, res) => {
  const { id } = req.params;
  await Campground.findByIdAndDelete(id);
  res.redirect('/campgrounds');
}));

// vanilla Prettier output
app.delete(
  "/campgrounds/:id",
  catchAsync(async (req, res) => {
    const { id } = req.params;
    await Campground.findByIdAndDelete(id);
    res.redirect("/campgrounds");
  }),
);

// with this plugin
app.delete("/campgrounds/:id", catchAsync(async (req, res) => {
  const { id } = req.params;
  await Campground.findByIdAndDelete(id);
  res.redirect("/campgrounds");
}));
```

It also flattens method chains instead of breaking every `.method()` onto its
own line — a common look with query builders:

```js
// input
db.updateTable('User').set({
  isDeleted: true,
  profilePicture: null,
  username: null,
}).where('id', '=', user.id).execute();

// vanilla Prettier output
db
  .updateTable("User")
  .set({
    isDeleted: true,
    profilePicture: null,
    username: null,
  })
  .where("id", "=", user.id)
  .execute();

// with this plugin
db.updateTable("User").set({
  isDeleted: true,
  profilePicture: null,
  username: null,
}).where("id", "=", user.id).execute();
```

## How it works

This plugin wraps Prettier's built-in `estree` printer and only overrides the
`print` step for `CallExpression` and `ArrowFunctionExpression` nodes that
match one of a few narrow, specific shapes.

**Hugging a call-wrapped callback:**

- the callee is a plain identifier or non-computed member chain (`foo`,
  `a.b.c`) — chained calls (`a().b()`) are left untouched
- either the *last* argument is itself a call whose own last argument is a
  function/object/array literal (looked through recursively, so a chain of
  wrappers like `a(b(cb))` is still found — the common `catchAsync(cb)` case),
  or, for a 2-argument call whose second argument is short and simple (a
  literal or identifier), the *first* argument is such a wrapping call (the
  lodash-style `uniqueBy(collection, "key")` shape)
- the resulting line actually fits `printWidth`; if it doesn't (most often
  because a wrapping call itself sits inside *another* wrapping call), this
  falls back to Prettier's default printing for the outer call — inner calls
  still get their own independent chance to hug once Prettier places them at
  their own, shallower indentation
- there's no blank line between arguments, no comments on the relevant
  nodes, and no TS type arguments

**Hugging an arrow function's concise body:**

```js
// input
const f = (data) =>
  pgBoss.then((boss) => {
    return boss.send(jobName, data);
  });

// with this plugin
const f = (data) => pgBoss.then((boss) => {
  return boss.send(jobName, data);
});
```

- the arrow has a concise (non-block) body, no type parameters, return type,
  or predicate, and default `arrowParens`
- the body is a `CallExpression` that needs multi-line printing (Prettier
  already hugs directly after `=>` for other body types — objects, arrays,
  JSX, template literals — so there's no gap to fix there)
- the resulting line fits `printWidth`; otherwise this falls back to
  Prettier's default (a hardline after `=>`, body indented on its own line).
  The arrow's own parameter list can still break onto its own line first the
  normal way — only the `=> body` boundary is affected

**Flattening a method chain:**

- every link is a plain, non-optional `.name(...)` or `[expr](...)` call down
  to a simple base (an identifier, `this`, or a non-computed member chain)
- each link's own arguments are printed exactly as Prettier would print them
  standalone — a single object/array/function argument hugs the parens, a
  multi-argument list breaks onto its own lines only if it doesn't fit — so
  any number of links can break independently, correctly, with no special
  casing needed
- the whole flattened candidate is still rendered and measured against
  `printWidth` as a final check (catching the one thing per-link breaking
  can't: many short, individually-fitting links whose *combined* length
  still overflows); if any line would overflow, it falls back to Prettier's
  normal chain layout

Every other node, and every `CallExpression` that doesn't match one of these
shapes, is delegated unchanged to Prettier's original printer.

## Development

```sh
npm install
npm run build
npm test
```
