export function appBundlePath(executablePath: string) {
  return executablePath.match(/^(.*\.app)\/Contents\//)?.[1] ?? null;
}
