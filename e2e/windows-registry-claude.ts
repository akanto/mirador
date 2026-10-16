/** Run with Bun: prints the claude a Windows host finds on the PATH the registry holds, which a spec cannot change, or nothing. */
import { currentPath } from "../host/current-path.ts";

console.log(Bun.which("claude", { PATH: currentPath("") }) ?? "");
