import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";

export interface InstanceLock {
  release(): void;
}

async function reachesRunningInstance(socketPath: string) {
  try {
    const socket = await Bun.connect({ unix: socketPath, socket: { data() {} } });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

/**
 * Linux tells a running app nothing when it is launched again (macOS sends "reopen"), so a second launch connects to
 * the first one's socket, which opens its window, and gets null back so it can quit. The newcomer hangs up: had the
 * first one closed the connection, the newcomer could see it reset before it opened and start a second app.
 */
export async function claimSingleInstance(socketPath: string, onLaunchedAgain: () => void): Promise<InstanceLock | null> {
  if (await reachesRunningInstance(socketPath)) return null;
  mkdirSync(dirname(socketPath), { recursive: true });
  rmSync(socketPath, { force: true });
  const listener = Bun.listen({
    unix: socketPath,
    socket: {
      open: onLaunchedAgain,
      data() {},
    },
  });
  return {
    release() {
      listener.stop(true);
      rmSync(socketPath, { force: true });
    },
  };
}
