import type { VoiceEngineStatus } from "../../../shared/voice-engine.ts";
import type { ThisMac } from "../voice.ts";
import type { VoiceEngineInstaller } from "./installer.ts";
import type { VoiceEngineServers } from "./servers.ts";

/** Mirador's own speech engine on this Mac: set up by the installer, run by the servers. */
export class VoiceEngine {
  constructor(
    private readonly installer: VoiceEngineInstaller,
    private readonly servers: VoiceEngineServers,
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

  async remove() {
    await this.servers.stopAll();
    await this.installer.remove();
  }

  use: ThisMac = (service, work) => this.servers.use(service, work);

  async stop() {
    this.installer.cancel();
    await this.servers.stopAll();
  }

  killServersNow() {
    this.servers.killAllNow();
  }
}
