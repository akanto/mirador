import { expect, test } from "bun:test";
import { looksLikeFilePath } from "../shared/file-paths.ts";

test("an inline code span is a file path when it names a file with a folder", () => {
  expect(["/Users/me/a/b.ts", "src/app.ts", "docs/notes.md"].every(looksLikeFilePath)).toBe(true);
  expect(["foo()", "https://x.com/a.png", "a/b", "npm run test", "main"].some(looksLikeFilePath)).toBe(false);
});
