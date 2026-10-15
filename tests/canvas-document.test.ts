import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { resolveAsset } from "../host/canvas/assets.ts";
import { buildCanvasDocument, TEXT_CONTRAST_SCRIPT } from "../shared/canvas-document.ts";

const assetsOrigin = "http://127.0.0.1:4601";

describe("buildCanvasDocument", () => {
  test("puts the CSP before any agent markup, even for a full document with its own doctype", () => {
    const document = buildCanvasDocument("<!DOCTYPE html><html><head><script>evil()</script></head></html>", "item", assetsOrigin, "light");
    expect(document.startsWith("<!doctype html>\n<meta http-equiv=\"Content-Security-Policy\"")).toBe(true);
    expect(document.match(/<!doctype/gi)).toHaveLength(1);
    expect(document.indexOf("connect-src 'none'")).toBeLessThan(document.indexOf("evil()"));
  });

  test("maps three and its addons to the assets origin", () => {
    const document = buildCanvasDocument("<p>", "item", assetsOrigin, "light");
    expect(document).toContain(`"three":"${assetsOrigin}/three/build/three.module.js"`);
    expect(document).toContain(`"three/addons/":"${assetsOrigin}/three/addons/"`);
  });

  test("a padded page keeps its side spacing on html, ahead of the agent's own styles; other pages are left as the agent wrote them", () => {
    const agentStyle = "<style>body{margin:0}</style>";
    const padded = buildCanvasDocument(agentStyle, "item", assetsOrigin, "light", { padded: true });
    expect(padded.indexOf("html{padding:0 8px}body{margin-left:0;margin-right:0}")).toBeGreaterThan(-1);
    expect(padded.indexOf("html{padding:0 8px}")).toBeLessThan(padded.indexOf(agentStyle));
    expect(buildCanvasDocument(agentStyle, "item", assetsOrigin, "light")).not.toContain("html{padding");
  });

  test("embeds the item id safely in the error reporter", () => {
    const document = buildCanvasDocument("<p>", '"; alert(1); "', assetsOrigin, "light");
    expect(document).toContain(JSON.stringify('"; alert(1); "'));
  });
});

type ReadableTextColor = (color: string, backgrounds: string[], scheme: "light" | "dark") => string | null;
const readableTextColor = new Function(`${TEXT_CONTRAST_SCRIPT}; return readableTextColor;`)() as ReadableTextColor;

describe("readableTextColor", () => {
  test("dark theme text on a light code background takes the light theme's text colour", () => {
    expect(readableTextColor("rgb(236, 236, 236)", ["rgb(244, 244, 245)", "rgb(17, 17, 17)"], "dark")).toBe("rgb(23, 23, 23)");
  });

  test("light theme text on a dark code block takes the dark theme's text colour", () => {
    expect(readableTextColor("rgb(23, 23, 23)", ["rgb(29, 33, 40)"], "light")).toBe("rgb(236, 236, 236)");
  });

  test("muted text that still reads is left as the page has it", () => {
    expect(readableTextColor("rgb(115, 115, 115)", ["rgb(255, 255, 255)"], "light")).toBeNull();
    expect(readableTextColor("rgb(139, 148, 158)", ["rgb(17, 17, 17)"], "dark")).toBeNull();
    expect(readableTextColor("rgb(153, 153, 153)", ["rgb(255, 255, 255)"], "light")).toBeNull();
  });

  test("grey text that all but vanishes into the background takes the theme text colour", () => {
    expect(readableTextColor("rgb(68, 68, 68)", ["rgb(17, 17, 17)"], "dark")).toBe("rgb(236, 236, 236)");
    expect(readableTextColor("rgb(170, 170, 170)", ["rgb(255, 255, 255)"], "light")).toBe("rgb(23, 23, 23)");
  });

  test("a see-through background is judged with what shows through it", () => {
    expect(readableTextColor("rgb(236, 236, 236)", ["rgba(255, 255, 255, 0.9)", "rgba(0, 0, 0, 0)", "rgb(17, 17, 17)"], "dark")).toBe("rgb(23, 23, 23)");
    expect(readableTextColor("rgb(236, 236, 236)", ["rgba(255, 255, 255, 0.05)", "rgb(17, 17, 17)"], "dark")).toBeNull();
  });

  test("with no background of its own all the way out, the text is judged on the theme's page colour", () => {
    expect(readableTextColor("rgb(240, 240, 240)", ["rgba(0, 0, 0, 0)"], "light")).toBe("rgb(23, 23, 23)");
    expect(readableTextColor("rgb(240, 240, 240)", ["rgba(0, 0, 0, 0)"], "dark")).toBeNull();
  });

  test("leaves text alone that is meant to be faint or whose colours it cannot read", () => {
    expect(readableTextColor("rgba(0, 0, 0, 0)", ["rgb(255, 255, 255)"], "light")).toBeNull();
    expect(readableTextColor("rgba(255, 255, 255, 0.3)", ["rgb(255, 255, 255)"], "light")).toBeNull();
    expect(readableTextColor("oklch(0.95 0 0)", ["rgb(255, 255, 255)"], "light")).toBeNull();
    expect(readableTextColor("rgb(250, 250, 250)", ["color(srgb 1 1 1)"], "light")).toBeNull();
  });
});

describe("resolveAsset", () => {
  test("serves library files", () => {
    expect(resolveAsset("/d3.min.js")).toEndWith(join("d3", "dist", "d3.min.js"));
    expect(resolveAsset("/three/addons/controls/OrbitControls.js")).toEndWith(join("three", "examples", "jsm", "controls", "OrbitControls.js"));
  });

  test("refuses paths outside the mounted directories", () => {
    expect(resolveAsset("/three/addons/../../package.json")).toBeNull();
    expect(resolveAsset("/three/addons/%2e%2e/%2e%2e/package.json")).toBeNull();
    expect(resolveAsset("/etc/passwd")).toBeNull();
  });
});
