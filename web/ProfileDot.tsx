import type { Profile } from "../shared/model.ts";
import { profileColorVariable } from "./pastels.ts";

/** Goes before the profile's name, so a workspace or conversation on the wrong profile stands out. */
export function ProfileDot({ profile }: { profile: Profile | undefined }) {
  if (!profile?.color) return null;
  return <span className="profile-dot" data-color={profile.color} aria-hidden="true" style={profileColorVariable(profile.color)} />;
}
