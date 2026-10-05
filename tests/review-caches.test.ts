import { beforeEach, describe, expect, test } from "bun:test";
import { connection } from "../web/connection.ts";
import { evictStaleReviewCaches, reviewedFile, reviewedFiles, shownContexts } from "../web/Review.tsx";

describe("review caches and eviction", () => {
  beforeEach(() => {
    shownContexts.clear();
    reviewedFiles.clear();
  });

  test("evictStaleReviewCaches drops contexts and files for older review items", () => {
    shownContexts.set("old-1:file.ts", { fileLines: ["line 1"], revealed: [] });
    shownContexts.set("old-2:file.ts", { fileLines: ["line 2"], revealed: [] });
    shownContexts.set("current:file.ts", { fileLines: ["line 3"], revealed: [] });

    reviewedFiles.set("old-1:file.ts", Promise.resolve(["line 1"]));
    reviewedFiles.set("current:file.ts", Promise.resolve(["line 3"]));

    evictStaleReviewCaches("current");

    expect(Array.from(shownContexts.keys())).toEqual(["current:file.ts"]);
    expect(Array.from(reviewedFiles.keys())).toEqual(["current:file.ts"]);
  });

  test("reviewedFile caches the in-flight promise and clears it on failure so retrying works", async () => {
    // When connection is not open, reviewedFile immediately rejects
    connection.setStatus("connecting");

    const failed = reviewedFile("item-1", "src/index.ts");
    await expect(failed).rejects.toThrow("Not connected to the host.");

    // The key should have been evicted from reviewedFiles on rejection
    expect(reviewedFiles.has("item-1:src/index.ts")).toBe(false);

    // If connection opens, next call gets a new request instead of the dead rejected promise
    (connection as unknown as { socket: { readyState: number; send: (raw: string) => void } }).socket = {
      readyState: 1,
      send: (raw) => {
        const message = JSON.parse(raw);
        if (message.type === "review.read-file") {
          setTimeout(() => {
            connection.dispatchMessage({
              type: "review.file-read",
              requestId: message.requestId,
              lines: ["first line", "second line"],
            });
          }, 0);
        }
      },
    };
    connection.setStatus("open");

    const retried = reviewedFile("item-1", "src/index.ts");
    expect(reviewedFiles.has("item-1:src/index.ts")).toBe(true);
    expect(await retried).toEqual(["first line", "second line"]);
  });
});
