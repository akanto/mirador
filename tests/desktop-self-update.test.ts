import { expect, test } from "bun:test";
import { SelfUpdate, type PublishedBuild, type SelfUpdatePorts, type UpdateOffer } from "../desktop/src/core/self-update.ts";

const RUNNING = "0.5.0";

class World {
  published: PublishedBuild | null = { version: "0.6.0", hash: "hash060" };
  blockedBy: string | null = null;
  trusted = true;
  downloadFails = false;
  skipped = new Set<string>();
  events: string[] = [];
  offers: (UpdateOffer | null)[] = [];

  selfUpdate() {
    const world = this;
    const ports: SelfUpdatePorts = {
      currentVersion: RUNNING,
      published: async () => world.published,
      blockedBy: () => world.blockedBy,
      async download({ hash }) {
        world.events.push(`download ${hash}`);
        if (world.downloadFails) throw new Error("offline");
      },
      trusted: async ({ hash }) => {
        world.events.push(`check ${hash}`);
        return world.trusted;
      },
      discard: (hash) => world.events.push(`discard ${hash}`),
      skipped: { has: (hash) => world.skipped.has(hash), add: (hash) => void world.skipped.add(hash) },
      install: async () => void world.events.push("install"),
    };
    return new SelfUpdate(ports, (offer) => world.offers.push(offer));
  }
}

test("a newer release is downloaded, checked and then offered", async () => {
  const world = new World();
  const selfUpdate = world.selfUpdate();

  await selfUpdate.look();

  expect(world.events).toEqual(["download hash060", "check hash060"]);
  expect(selfUpdate.offer).toEqual({ version: "0.6.0", hash: "hash060", blockedBy: null });
  expect(world.offers).toEqual([selfUpdate.offer]);
});

test("only a newer version is offered: the latest release may be older, or this version built again", async () => {
  for (const version of ["0.4.9", RUNNING]) {
    const world = new World();
    world.published = { version, hash: "other" };
    const selfUpdate = world.selfUpdate();

    await selfUpdate.look();

    expect(world.events).toEqual([]);
    expect(selfUpdate.offer).toBeNull();
  }
});

test("a download whose signature fails is deleted and never fetched again", async () => {
  const world = new World();
  world.trusted = false;
  const selfUpdate = world.selfUpdate();

  await selfUpdate.look();
  await selfUpdate.look();

  expect(world.events).toEqual(["download hash060", "check hash060", "discard hash060"]);
  expect(world.skipped.has("hash060")).toBe(true);
  expect(selfUpdate.offer).toBeNull();
});

test("where the app cannot replace itself, it says why and downloads nothing", async () => {
  const world = new World();
  world.blockedBy = "move Mirador to Applications to update it";
  const selfUpdate = world.selfUpdate();

  await selfUpdate.look();

  expect(world.events).toEqual([]);
  expect(selfUpdate.offer).toEqual({ version: "0.6.0", hash: "hash060", blockedBy: "move Mirador to Applications to update it" });
  await selfUpdate.install();
  expect(world.events).toEqual([]);
});

test("once moved where it can replace itself, the next look downloads it", async () => {
  const world = new World();
  world.blockedBy = "move Mirador to Applications to update it";
  const selfUpdate = world.selfUpdate();
  await selfUpdate.look();

  world.blockedBy = null;
  await selfUpdate.look();

  expect(world.events).toEqual(["download hash060", "check hash060"]);
  expect(selfUpdate.offer?.blockedBy).toBeNull();
});

test("an update already offered is not downloaded again at the next look", async () => {
  const world = new World();
  const selfUpdate = world.selfUpdate();
  await selfUpdate.look();
  await selfUpdate.look();

  expect(world.events).toEqual(["download hash060", "check hash060"]);
  expect(world.offers).toHaveLength(1);
});

test("a failed download offers nothing, and the next look tries again", async () => {
  const world = new World();
  world.downloadFails = true;
  const selfUpdate = world.selfUpdate();
  await selfUpdate.look();
  expect(selfUpdate.offer).toBeNull();

  world.downloadFails = false;
  await selfUpdate.look();
  expect(selfUpdate.offer?.version).toBe("0.6.0");
});

test("a build that failed to install is deleted, no longer offered, and skipped from then on", async () => {
  const world = new World();
  const selfUpdate = world.selfUpdate();
  await selfUpdate.look();

  selfUpdate.failedToInstall("hash060");
  await selfUpdate.look();

  expect(world.events).toEqual(["download hash060", "check hash060", "discard hash060"]);
  expect(selfUpdate.offer).toBeNull();
  expect(world.offers.at(-1)).toBeNull();
});

test("installing restarts into the offered update, and only when there is one", async () => {
  const world = new World();
  world.published = null;
  const selfUpdate = world.selfUpdate();
  await selfUpdate.look();
  await selfUpdate.install();
  expect(world.events).toEqual([]);

  world.published = { version: "0.6.0", hash: "hash060" };
  await selfUpdate.look();
  await selfUpdate.install();
  expect(world.events.at(-1)).toBe("install");
});
