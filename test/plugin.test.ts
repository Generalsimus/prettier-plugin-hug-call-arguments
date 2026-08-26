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
