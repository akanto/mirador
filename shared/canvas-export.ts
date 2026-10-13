/** Where a page saved or copied out of the canvas loads its libraries (D3, Mermaid, three.js) from. */
export type PageLibraries = "cdn" | "inline";

export const pageLibrariesLabels: Record<PageLibraries, string> = {
  cdn: "From a public CDN: small files that need a network connection to draw",
  inline: "Inside the file: works offline, but Mermaid adds about 3 MB",
};

const LONGEST_NAME = 60;

/** A file name for a page, after its title. */
export function pageFileName(title: string) {
  const name = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, LONGEST_NAME)
    .replace(/^-+|-+$/g, "");
  return `${name || "canvas-page"}.html`;
}

/** Where Save to project offers to put a page. */
export const suggestedPagePath = (title: string) => `docs/${pageFileName(title)}`;
