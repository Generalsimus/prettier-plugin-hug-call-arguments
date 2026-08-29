import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import prettier from "prettier";

const plugin = path.join(__dirname, "..", "dist", "index.js");

async function format(
  source: string,
  parser: "babel" | "babel-ts" = "babel",
): Promise<string> {
  return prettier.format(source, {
    parser,
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

test("hugs a single-line object with a mix of quoted and unquoted string values", async () => {
  const input = `await db.updateTable('User').set({ isDeleted: true, profilePicture: null, username: null, name: 'Deleted user', bio: null, isVerified: false, email: "email", updatedAt: new Date() }).where('id', '=', user.id).execute();
`;
  const expected = `await db.updateTable("User").set({
  isDeleted: true,
  profilePicture: null,
  username: null,
  name: "Deleted user",
  bio: null,
  isVerified: false,
  email: "email",
  updatedAt: new Date(),
}).where("id", "=", user.id).execute();
`;
  assert.equal(await format(input), expected);
});

test("hugs through a wrapping call whose huggable argument comes first, not last (lodash-style uniqueBy(collection, key))", async () => {
  const input = `const roomParticipantsInfo = await RoomService.getRoomParticipantsInfo(
            uniqueBy(room.participants.map((el) => ({
                roomId: el.roomId,
                participantIdentity: el.identity,
              })), 'participantIdentity'),
          );
`;
  // uniqueBy(...)'s two arguments are written on one line in the source, so
  // the "preserve original layout" rule doesn't apply here — this exercises
  // the hugging feature itself. The outer getRoomParticipantsInfo(...) call
  // is left to Prettier's default breakout (its own opening line would
  // badly overflow printWidth if fused); the inner uniqueBy(...) still hugs
  // its own map() argument, since at its own (shallower) indent that fits
  // comfortably.
  const expected = `const roomParticipantsInfo = await RoomService.getRoomParticipantsInfo(
  uniqueBy(room.participants.map((el) => ({
    roomId: el.roomId,
    participantIdentity: el.identity,
  })), "participantIdentity"),
);
`;
  assert.equal(await format(input), expected);
});

test("hugs an arrow function's concise call-expression body against =>, instead of breaking after it", async () => {
  const input = `export const scheduleCommentRoomQueueWorker = (data: commentRoomQueueWorkerJob) =>
  pgBoss.then((boss) => {
    return boss.send(commentRoomQueueWorkerName, data, {
      singletonKey: data.roomId.toString(),
      retryLimit: 1,
    });
  });
`;
  // The full signature ("export const ... = (data: commentRoomQueueWorkerJob) =>")
  // is too long to fit on one line, so the params still break onto their own
  // line the normal way — but the body now hugs directly against the
  // resulting ") =>" instead of getting a hardline and its own indented line.
  const expected = `export const scheduleCommentRoomQueueWorker = (
  data: commentRoomQueueWorkerJob,
) => pgBoss.then((boss) => {
  return boss.send(commentRoomQueueWorkerName, data, {
    singletonKey: data.roomId.toString(),
    retryLimit: 1,
  });
});
`;
  assert.equal(await format(input, "babel-ts"), expected);
});

test("preserves call arguments written on separate lines, even though they'd fit on one line", async () => {
  const input = `foo(
  1,
  2,
);
`;
  // Same behavior Prettier already gives object literals by default
  // (objectWrap: "preserve"): a newline right after "(" before the first
  // argument means the developer chose this layout on purpose, so it's kept
  // even though "foo(1, 2);" would easily fit under printWidth.
  const expected = `foo(
  1,
  2,
);
`;
  assert.equal(await format(input), expected);
});

test("collapses call arguments written on one line, same as always", async () => {
  const input = `bar(1, 2, 3);
`;
  const expected = `bar(1, 2, 3);
`;
  assert.equal(await format(input), expected);
});

test("preserves array elements written on separate lines, even though they'd fit on one line", async () => {
  const input = `const arr = [
  1,
  2,
];
`;
  const expected = `const arr = [
  1,
  2,
];
`;
  assert.equal(await format(input), expected);
});

test("still breaks an array written on one line that's too long to fit, the normal Prettier way", async () => {
  const input = `const many = ["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc", "dddddddddd", "eeeeeeeeee"];
`;
  const expected = `const many = [
  "aaaaaaaaaa",
  "bbbbbbbbbb",
  "cccccccccc",
  "dddddddddd",
  "eeeeeeeeee",
];
`;
  assert.equal(await format(input), expected);
});

test("preserves arrow function parameters written on separate lines", async () => {
  const input = `const add = (
  x,
  y,
) => {
  return x + y;
};
`;
  const expected = `const add = (
  x,
  y,
) => {
  return x + y;
};
`;
  assert.equal(await format(input), expected);
});

test("does not preserve a single argument written on its own line — that's not a 'one per line' layout", async () => {
  const input = `foo(
  singleArg,
);
`;
  const expected = `foo(singleArg);
`;
  assert.equal(await format(input), expected);
});

test("hugs a call whose sole argument is a plain object, through a wrapping call, through a deep member-chain callee", async () => {
  // Regression test: getVideoFrameSpriteSheet({ ... })'s argument is
  // directly an object literal (not itself wrapped in a function), and
  // its own callee is a multi-level member chain. couldExpandArg() only
  // recognized functions as directly huggable, missing this — and the
  // deep member-chain callee, once printed standalone via print("callee")
  // disconnected from its normal call context, would break at its own
  // dots (a real Prettier quirk, unrelated to width) unless rendered flat.
  const input = `class X {
  getVideoFrameSpriteSheet(data) {
    return firstValueFrom(this.videoGrpcService.client.getVideoFrameSpriteSheet({
      fileKey: data.fileKey, frameCount: SPRITE_SHEET_FRAME_COUNT }));
  }
}
`;
  const expected = `class X {
  getVideoFrameSpriteSheet(data) {
    return firstValueFrom(this.videoGrpcService.client.getVideoFrameSpriteSheet({
      fileKey: data.fileKey,
      frameCount: SPRITE_SHEET_FRAME_COUNT,
    }));
  }
}
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
