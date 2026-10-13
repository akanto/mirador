import { lstat, mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export class SaveRefused extends Error {}

export class FileAlreadyThere extends SaveRefused {}

const HTML_NAME = /\.html?$/i;

const escapes = (relativePath: string) => relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);

const isWithin = (root: string, path: string) => !escapes(relative(root, path));

const isInside = (root: string, path: string) => relative(root, path) !== "" && isWithin(root, path);

const toPosix = (path: string) => path.split(sep).join("/");

const outsideWorkspace = (name: string) => new SaveRefused(`"${name}" is not a file inside the project folder.`);

const statOf = (path: string) => stat(path).catch(() => undefined);

/** A link on the way can lead out of the workspace, so the real place of the nearest existing entry decides. */
async function realPlaceOf(path: string): Promise<string> {
  const exists = await lstat(path).then(() => true, () => false);
  return exists ? realpath(path) : realPlaceOf(dirname(path));
}

async function assertNotLeadingOut(root: string, target: string, name: string) {
  const realLocation = await realPlaceOf(target).catch(() => undefined);
  if (realLocation === undefined || !isWithin(root, realLocation)) throw outsideWorkspace(name);
}

export async function saveIntoWorkspace(workspaceRoot: string, path: string, content: string, { replace = false } = {}): Promise<string> {
  const name = path.trim();
  if (name === "") throw new SaveRefused("Name the file to save the page as.");
  if (isAbsolute(name)) throw new SaveRefused(`"${name}" is an absolute path. Give a path inside the project folder.`);

  const root = await realpath(workspaceRoot);
  const target = resolve(root, name);
  if (!isInside(root, target)) throw outsideWorkspace(name);
  await assertNotLeadingOut(root, target, name);
  if (!HTML_NAME.test(name)) throw new SaveRefused("Save the page as an .html file.");

  const existing = await statOf(target);
  if (existing?.isDirectory()) throw new SaveRefused(`"${name}" is a folder. Name the page differently.`);
  const saved = toPosix(relative(root, target));
  if (existing && !replace) throw new FileAlreadyThere(`${saved} is already there.`);

  await mkdir(dirname(target), { recursive: true }).catch(() => {
    throw new SaveRefused(`Part of "${name}" is a file, not a folder.`);
  });
  await writeFile(target, content, "utf8");
  return saved;
}
