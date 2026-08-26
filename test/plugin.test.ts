import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import prettier from "prettier";

const plugin = path.join(__dirname, "..", "dist", "index.js");

async function format(source: string): Promise<string> {
  return prettier.format(source, {
    parser: "babel",
    plugins: [plugin],
  });
}

test("hugs a call-wrapped callback (the reported issue)", async () => {
  const input = `app.delete('/campgrounds/:id', catchAsync(async (req, res) => {
  const { id } = req.params;
  await Campground.findByIdAndDelete(id);
  res.redirect('/campgrounds');
}));
`;
  const expected = `app.delete("/campgrounds/:id", catchAsync(async (req, res) => {
  const { id } = req.params;
  await Campground.findByIdAndDelete(id);
  res.redirect("/campgrounds");
}));
`;
  assert.equal(await format(input), expected);
});

test("hugs a sole wrapped callback", async () => {
  const input = `app.use(catchAsync(async (req, res) => {
  res.send('ok');
}));
`;
  assert.equal(await format(input), input.replace(/'/g, '"'));
});

test("leaves plain (already-huggable) callbacks untouched", async () => {
  const input = `app.get("/x", (req, res) => {
  res.send("ok");
});
`;
  assert.equal(await format(input), input);
});

test("falls back to breaking all args when the head args don't fit", async () => {
  const output = await format(
    `someObject.someMethodWithAVeryLongName('a-fairly-long-string-argument-here', catchAsync(async (req, res) => {\n  doStuff();\n}));\n`,
  );
  assert.equal(
    output,
    `someObject.someMethodWithAVeryLongName(
  "a-fairly-long-string-argument-here",
  catchAsync(async (req, res) => {
    doStuff();
  }),
);
`,
  );
});

test("does not touch member/call chains", async () => {
  const input = `somePromise().then((result) => {
  return catchAsync(async (req, res) => {
    doStuff();
  });
});
`;
  assert.equal(await format(input), input);
});

test("hugs the one breaking argument in a short method chain", async () => {
  const input = `db.updateTable('User').set({
  isDeleted: true,
  profilePicture: null,
  username: null,
}).where('id', '=', user.id).execute();
`;
  const expected = `db.updateTable("User").set({
  isDeleted: true,
  profilePicture: null,
  username: null,
}).where("id", "=", user.id).execute();
`;
  assert.equal(await format(input), expected);
});

test("falls back to Prettier's normal chain layout when two links break", async () => {
  const input = `db.updateTable('User').set({
  isDeleted: true,
}).where({
  id: user.id,
  active: true,
}).execute();
`;
  const expected = `db.updateTable("User")
  .set({
    isDeleted: true,
  })
  .where({
    id: user.id,
    active: true,
  })
  .execute();
`;
  assert.equal(await format(input), expected);
});

test("falls back when the flattened chain would overflow printWidth", async () => {
  const input = `db.updateTable('User').set({
  isDeleted: true,
  profilePicture: null,
}).where('some-really-long-condition-column-name-that-does-not-fit-at-all-on-one-line', '=', user.id).execute();
`;
  // The flattened one-block-per-call layout would push
  // `.where(...).execute();` onto an overflowing line, so this must fall
  // back to Prettier's normal per-call chain layout instead (the string
  // literal argument itself still can't be wrapped, which is an unrelated,
  // pre-existing Prettier limitation — not something this plugin controls).
  const expected = `db.updateTable("User")
  .set({
    isDeleted: true,
    profilePicture: null,
  })
  .where(
    "some-really-long-condition-column-name-that-does-not-fit-at-all-on-one-line",
    "=",
    user.id,
  )
  .execute();
`;
  assert.equal(await format(input), expected);
});

test("does not touch chains with computed member access", async () => {
  const input = `db.updateTable('User')[method]({
  isDeleted: true,
  profilePicture: null,
}).execute();
`;
  const expected = `db.updateTable("User")
  [method]({
    isDeleted: true,
    profilePicture: null,
  })
  .execute();
`;
  assert.equal(await format(input), expected);
});

test("output is idempotent", async () => {
  const input = `app.delete('/campgrounds/:id', catchAsync(async (req, res) => {
  const { id } = req.params;
  await Campground.findByIdAndDelete(id);
  res.redirect('/campgrounds');
}));
`;
  const once = await format(input);
  const twice = await format(once);
  assert.equal(once, twice);
});
