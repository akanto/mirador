import { describe, expect, test } from "bun:test";
import { resolveAsset } from "../host/canvas/assets.ts";
import { buildCanvasDocument } from "../shared/canvas-document.ts";

const assetsOrigin = "http://127.0.0.1:4601";

describe("buildCanvasDocument", () => {
  test("puts the CSP before any agent markup, even for a full document with its own doctype", () => {
    const document = buildCanvasDocument("<!DOCTYPE html><html><head><script>evil()</script></head></html>", "item", assetsOrigin);
    expect(document.startsWith("<!doctype html>\n<meta http-equiv=\"Content-Security-Policy\"")).toBe(true);
    expect(document.match(/<!doctype/gi)).toHaveLength(1);
    expect(document.indexOf("connect-src 'none'")).toBeLessThan(document.indexOf("evil()"));
  });

  test("maps three and its addons to the assets origin", () => {
    const document = buildCanvasDocument("<p>", "item", assetsOrigin);
    expect(document).toContain(`"three":"${assetsOrigin}/three/build/three.module.js"`);
    expect(document).toContain(`"three/addons/":"${assetsOrigin}/three/addons/"`);
  });

  test("embeds the item id safely in the error reporter", () => {
    const document = buildCanvasDocument("<p>", '"; alert(1); "', assetsOrigin);
    expect(document).toContain(JSON.stringify('"; alert(1); "'));
  });
});

describe("resolveAsset", () => {
  test("serves library files", () => {
    expect(resolveAsset("/d3.min.js")).toEndWith("d3/dist/d3.min.js");
    expect(resolveAsset("/three/addons/controls/OrbitControls.js")).toEndWith("three/examples/jsm/controls/OrbitControls.js");
  });

  test("refuses paths outside the mounted directories", () => {
    expect(resolveAsset("/three/addons/../../package.json")).toBeNull();
    expect(resolveAsset("/three/addons/%2e%2e/%2e%2e/package.json")).toBeNull();
    expect(resolveAsset("/etc/passwd")).toBeNull();
  });
});
