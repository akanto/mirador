import { askModeLabels, harnessIds, harnessLabels, type Launch, type Profile } from "../shared/model.ts";
import { parseEnvironment } from "../shared/profile-environment.ts";
import type { ProfileDraft } from "../shared/protocol.ts";
import type { ConversationService } from "./conversations.ts";
import type { Hub } from "./hub.ts";
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
    this.hub.broadcast({ type: "profile.upserted", profile });
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
