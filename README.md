# prettier-plugin-hug-call-arguments

Fixes [prettier/prettier#11080](https://github.com/prettier/prettier/issues/11080).

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

## How it works

This plugin wraps Prettier's built-in `estree` printer and only overrides the
`print` step for `CallExpression` nodes that match a narrow, specific shape:

- the callee is a plain identifier or non-computed member chain (`foo`,
  `a.b.c`) — chained calls (`a().b()`) are left untouched
- the last argument is itself a call whose own last argument is a
  function/object/array literal (looked through recursively)
- every earlier argument fits on the opening line
- there's no blank line between arguments, no comments on the relevant
  nodes, and no TS type arguments

Every other node, and every `CallExpression` that doesn't match that shape,
is delegated unchanged to Prettier's original printer.

## Usage

```sh
npm install --save-dev prettier-plugin-hug-call-arguments
```

`.prettierrc`:

```json
{
  "plugins": ["prettier-plugin-hug-call-arguments"]
}
```

## Development

```sh
npm install
npm run build
npm test
```
