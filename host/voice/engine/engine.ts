import type { VoiceEngineStatus } from "../../../shared/voice-engine.ts";
import { VoiceUnavailable, type ThisMac } from "../voice.ts";
import type { VoiceEngineInstaller } from "./installer.ts";
import type { VoiceEngineServers } from "./servers.ts";

/** Mirador's own speech engine on this Mac: set up by the installer, run by the servers. */
export class VoiceEngine {
  private removing = false;

  constructor(
    private readonly installer: Pick<VoiceEngineInstaller, "status" | "setUp" | "cancel" | "remove">,
    private readonly servers: Pick<VoiceEngineServers, "states" | "use" | "stopAll" | "killAllNow" | "idleTimeChanged">,
  ) {}

  status(): VoiceEngineStatus {
    return { ...this.installer.status(), servers: this.servers.states() };
  }

  setUp(withVoiceModel: boolean) {
    this.installer.setUp(withVoiceModel);
  }

  cancel() {
    this.installer.cancel();
  }

  /** No server starts while removing, so none runs from files about to be deleted. */
  async remove() {
    this.removing = true;
    try {
      await this.servers.stopAll();
      await this.installer.remove();
    } finally {
      this.removing = false;
    }
  }

  use: ThisMac = (service, work) => (this.removing ? Promise.reject(new VoiceUnavailable("Voice is being removed from this Mac.")) : this.servers.use(service, work));

  idleTimeChanged() {
    this.servers.idleTimeChanged();
  }

  async stop() {
    this.installer.cancel();
    await this.servers.stopAll();
  }

  killServersNow() {
    this.servers.killAllNow();
  }
}
