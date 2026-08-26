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

test("hugs an object argument that's too long to fit even though it's written on one line in the source", async () => {
  // Regression test: the object here has no forced break (objectWrap
  // wouldn't kick in, since it's on one line in the source) — it only
  // breaks because it doesn't fit under printWidth. `willBreak()` alone
  // can't see that, which was silently disabling this whole feature for
  // any inline object literal (see wouldBreakStandalone).
  const input = `await db
  .updateTable('User')
  .set({ isDeleted: true, profilePicture: null, username: null, name: 'Deleted user', bio: null, isVerified: false, email: \`\${user.id}-email\`, updatedAt: new Date() })
  .where('id', '=', user.id)
  .execute();
`;
  const expected = `await db.updateTable("User").set({
  isDeleted: true,
  profilePicture: null,
  username: null,
  name: "Deleted user",
  bio: null,
  isVerified: false,
  email: \`\${user.id}-email\`,
  updatedAt: new Date(),
}).where("id", "=", user.id).execute();
`;
  assert.equal(await format(input), expected);
});

test("keeps the chain flat even when two links break, each with its own object", async () => {
  const input = `db.updateTable("User")
  .set({
    isDeleted: true,
  })
  .where({
    id: user.id,
    active: true,
  })
  .execute();
`;
  const expected = `db.updateTable("User").set({
  isDeleted: true,
}).where({
  id: user.id,
  active: true,
}).execute();
`;
  assert.equal(await format(input), expected);
});

test("keeps the chain flat and lets a link's own arguments break independently", async () => {
  const input = `db.updateTable("User")
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
  // The chain itself stays flat; `.where(...)`'s own 3-argument list just
  // breaks on its own (normal Prettier call-argument behavior) since it
  // doesn't fit — the string literal itself still can't be wrapped, which
  // is an unrelated, pre-existing Prettier limitation.
  const expected = `db.updateTable("User").set({
  isDeleted: true,
  profilePicture: null,
}).where(
  "some-really-long-condition-column-name-that-does-not-fit-at-all-on-one-line",
  "=",
  user.id,
).execute();
`;
  assert.equal(await format(input), expected);
});

test("hugs chains with computed member access too", async () => {
  const input = `db.updateTable("User")
  [method]({
    isDeleted: true,
    profilePicture: null,
  })
  .execute();
`;
  const expected = `db.updateTable("User")[method]({
  isDeleted: true,
  profilePicture: null,
}).execute();
`;
  assert.equal(await format(input), expected);
});

test("hugs a two-link chain (no leading .method() before the breaking one)", async () => {
  const input = `query.select('*').where({
  id: 1,
  active: true,
  role: 'admin',
});
`;
  const expected = `query.select("*").where({
  id: 1,
  active: true,
  role: "admin",
});
`;
  assert.equal(await format(input), expected);
});

test("hugs a chain where the breaking argument is the last call", async () => {
  const input = `db.updateTable('User').where('id', '=', user.id).set({
  isDeleted: true,
  profilePicture: null,
  username: null,
});
`;
  const expected = `db.updateTable("User").where("id", "=", user.id).set({
  isDeleted: true,
  profilePicture: null,
  username: null,
});
`;
  assert.equal(await format(input), expected);
});

test("hugs an array argument the same way as an object argument", async () => {
  const input = `db.updateTable('User').set(['isDeleted', 'profilePicture', 'username', 'name', 'bio', 'isVerified']).where('id', '=', user.id).execute();
`;
  const expected = `db.updateTable("User").set([
  "isDeleted",
  "profilePicture",
  "username",
  "name",
  "bio",
  "isVerified",
]).where("id", "=", user.id).execute();
`;
  assert.equal(await format(input), expected);
});

test("hugs a longer chain (five links) with one breaking argument", async () => {
  const input = `qb.select('*').from('users').where('active', '=', true).orderBy('id').set({
  isDeleted: true,
  profilePicture: null,
  username: null,
});
`;
  const expected = `qb.select("*").from("users").where("active", "=", true).orderBy("id").set({
  isDeleted: true,
  profilePicture: null,
  username: null,
});
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
