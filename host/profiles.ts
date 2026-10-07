import { askModeLabels, harnessIds, harnessLabels, type HarnessId, type Launch, type Profile } from "../shared/model.ts";
import { parseEnvironment } from "../shared/profile-environment.ts";
import type { ProfileDraft } from "../shared/protocol.ts";
import type { ConversationService } from "./conversations.ts";
import type { BrowserSocket, Hub } from "./hub.ts";
import type { Store } from "./store.ts";

/** A profile runs only on the agent it was made for; the picker sends both, and the host checks they agree. */
export function assertLaunchable(store: Store, launch: Launch) {
  if (!harnessIds.includes(launch.harness)) throw new Error(`Unknown agent ${launch.harness}.`);
  if (launch.profileId === null) return;
  const profile = store.findProfile(launch.profileId);
  if (!profile) throw new Error("That profile no longer exists.");
  if (profile.harness !== launch.harness) {
    throw new Error(`Profile "${profile.name}" is for ${harnessLabels[profile.harness]}, not ${harnessLabels[launch.harness]}.`);
  }
}

/**
 * Workspaces and conversations from before every conversation ran on a profile move onto one per agent, named after it
 * and with nothing of its own, so they run as they did. Only for the agents this machine has a program for.
 */
export function moveProfilelessOntoProfiles(store: Store, installed: HarnessId[]) {
  store
    .profilelessHarnesses()
    .filter((harness) => installed.includes(harness))
    .forEach((harness) =>
      store.putProfilelessOn({
        id: crypto.randomUUID(),
        name: harnessLabels[harness],
        harness,
        environment: "",
        prelaunch: "",
        mode: null,
        bypassPermissions: false,
        askMode: "wait",
        createdAt: Date.now(),
      }),
    );
}

/** A profile as a socket gets it: without what it launches its agent with, unless the socket's page edits profiles. */
export const profileFor = (socket: BrowserSocket, profile: Profile): Profile =>
  socket.data.readsProfileLaunch ? profile : { ...profile, environment: "", prelaunch: "" };

export class ProfileService {
  constructor(
    private readonly store: Store,
    private readonly hub: Hub,
    private readonly conversations: ConversationService,
  ) {}

  save(draft: ProfileDraft): Profile {
    const name = draft.name.trim();
    if (!name) throw new Error("A profile needs a name.");
    const { errors } = parseEnvironment(draft.environment);
    if (errors.length > 0) throw new Error(errors.join("\n"));
    const existing = draft.id ? this.store.findProfile(draft.id) : undefined;
    if (draft.id && !existing) throw new Error("That profile no longer exists.");
    if (!harnessIds.includes(draft.harness)) throw new Error(`Unknown agent ${draft.harness}.`);
    if (!(draft.askMode in askModeLabels)) throw new Error(`Unknown Questions setting ${draft.askMode}.`);
    const profile: Profile = {
      id: existing?.id ?? crypto.randomUUID(),
      name,
      harness: existing?.harness ?? draft.harness,
      environment: draft.environment,
      prelaunch: draft.prelaunch,
      mode: draft.mode || null,
      bypassPermissions: draft.bypassPermissions,
      askMode: draft.askMode,
      createdAt: existing?.createdAt ?? Date.now(),
    };
    this.store.saveProfile(profile);
    const launchChanged = existing && (existing.environment !== profile.environment || existing.prelaunch !== profile.prelaunch);
    if (launchChanged) this.conversations.restartProfile(profile.id);
    this.hub.sendEach((socket) => ({ type: "profile.upserted", profile: profileFor(socket, profile) }));
    return profile;
  }

  delete(profileId: string) {
    const workspacesUsingIt = this.store.listWorkspaces().filter(({ defaultLaunch }) => defaultLaunch.profileId === profileId);
    this.store.deleteProfile(profileId);
    this.conversations.restartProfile(profileId);
    this.hub.broadcast({ type: "profile.deleted", profileId });
    workspacesUsingIt.forEach(({ id }) => this.hub.broadcast({ type: "workspace.upserted", workspace: this.store.findWorkspace(id)! }));
  }

  setWorkspaceDefault(workspaceId: string, launch: Launch) {
    assertLaunchable(this.store, launch);
    this.store.setWorkspaceDefaultLaunch(workspaceId, launch);
    const workspace = this.store.findWorkspace(workspaceId);
    if (workspace) this.hub.broadcast({ type: "workspace.upserted", workspace });
  }
}
