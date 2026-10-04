import { homedir } from "node:os";
import { basename } from "node:path";
import index from "../web/index.html";
import {
  isCanvasUse,
  isPastel,
  type CanvasUse,
  type PromptTemplate,
  type PublicAddress,
  type ReachabilitySettings,
  type Workspace,
  type Pastel,
} from "../shared/model.ts";
import { readJobWaitRequest } from "../shared/job-waits.ts";
import { promptTemplateProblem } from "../shared/prompt-templates.ts";
import { joinRequestNotification } from "../shared/system-notifications.ts";
import { TOKEN_COOKIE, type ClientMessage, type ServerMessage } from "../shared/protocol.ts";
import type { CanvasMcpEndpoints } from "./canvas/mcp.ts";
import type { CanvasService } from "./canvas/service.ts";
import { isImageId } from "../shared/images.ts";
import { movedBefore } from "../shared/sidebar-order.ts";
import { authorityFingerprint as fingerprintOf, type ServingCertificate } from "./certificates.ts";
import { publicAddressOf, reachability, savedNetwork, saveNetwork, savedPublicAddress, savePublicAddress, type HostConfig } from "./config.ts";
import { errorMessage, type ConversationService } from "./conversations.ts";
import { deviceName, type DeviceService } from "./devices.ts";
import { JobWaitRefused } from "./job-waits.ts";
import { JoinRequestRefused, SenderLimit, type JoinRequestService } from "./join-requests.ts";
import type { ConversationSearch } from "./search.ts";
import { machineAddress } from "../shared/machines.ts";
import { socketData, type BrowserSocket, type Hub, type SocketData } from "./hub.ts";
import type { MachineRelays } from "./machine-relays.ts";
import type { MachineWatch } from "./machine-watch.ts";
import { cookieValue, sameSecret, signedInWith } from "./sign-in.ts";
import { MAX_IMAGE_BYTES, type ImageStore } from "./images.ts";
import { completeDirectories, existingDirectory } from "./paths.ts";
import type { ProfileService } from "./profiles.ts";
import type { HostRestart } from "./restart.ts";
import type { StatuslineService } from "./statusline.ts";
import type { Store } from "./store.ts";
import type { TerminalService } from "./terminals.ts";

export interface HostServices {
  config: HostConfig;
  store: Store;
  hub: Hub;
  conversations: ConversationService;
  canvas: CanvasService;
  mcp: CanvasMcpEndpoints;
  profiles: ProfileService;
  statusline: StatuslineService;
  terminals: TerminalService;
  images: ImageStore;
  restart: HostRestart;
  devices: DeviceService;
  joinRequests: JoinRequestService;
  search: ConversationSearch;
  relays: MachineRelays;
  watch: MachineWatch;
  /** What the network listener serves with; null while the host listens on 127.0.0.1 only. */
  certificate: ServingCertificate | null;
}

const MAX_SCRIPT_MESSAGE_BYTES = 64 * 1024;
const hostRunId = crypto.randomUUID();

const parsedJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const isLoopback = (address: string) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address);

const tokenCookie = (token: string, secure: boolean) =>
  `${TOKEN_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000${secure ? "; Secure" : ""}`;


export function startServer(services: HostServices) {
  const {
    config,
    store,
    hub,
    conversations,
    canvas,
    mcp,
    profiles,
    statusline,
    terminals,
    images,
    restart,
    devices,
    joinRequests,
    search,
    relays,
    watch,
    certificate,
  } = services;
  const { network } = config.reachability;
  const localHosts = [`127.0.0.1:${config.port}`, `localhost:${config.port}`];
  const publicHost = config.publicOrigin ? [new URL(config.publicOrigin).host] : [];
  const networkHosts = network && certificate ? certificate.names.map((name) => `${name}:${network.port}`) : [];
  const allowedHosts = new Set([...localHosts, ...publicHost, ...networkHosts]);
  const hasAllowedHost = (request: Request) => allowedHosts.has(request.headers.get("host") ?? "");
  const pageOrigins = [config.appOrigin, config.publicOrigin, ...networkHosts.map((host) => `https://${host}`)].filter((origin) => origin !== null);
  const isPageOrigin = (origin: string | null) => origin !== null && pageOrigins.includes(origin);
  const localCanvasAssetsOrigin = `http://127.0.0.1:${config.canvasAssetsPort}`;

  /** Each page loads canvas libraries from the address it reached the host at, so it never needs to trust another. */
  function canvasAssetsOriginFor(request: Request) {
    const host = request.headers.get("host") ?? "";
    if (localHosts.includes(host)) return localCanvasAssetsOrigin;
    if (network && networkHosts.includes(host)) return `https://${host.slice(0, host.lastIndexOf(":"))}:${network.canvasPort}`;
    return config.canvasAssetsOrigin;
  }

  /** Public, so devices can trust Mirador's own certificate authority before they join. */
  const serveAuthority = () =>
    certificate?.authority
      ? new Response(certificate.authority, { headers: { "Content-Type": "application/x-pem-file", "Content-Disposition": 'attachment; filename="mirador-ca.pem"' } })
      : new Response("This Mirador has no certificate authority of its own.", { status: 404 });

  const signedInAs = signedInWith(config.browserToken, devices);

  function authenticate(request: Request) {
    if (!hasAllowedHost(request)) return new Response("forbidden host", { status: 403 });
    const url = new URL(request.url);
    if (url.hostname !== "127.0.0.1") return Response.redirect(`${config.appOrigin}${url.pathname}${url.search}`, 302);
    if (!sameSecret(url.searchParams.get("token"), config.browserToken)) {
      return new Response("Invalid token. Use the link printed by the host.", { status: 403 });
    }
    return new Response(null, {
      status: 302,
      headers: {
        Location: "/",
        "Set-Cookie": tokenCookie(config.browserToken, false),
      },
    });
  }

  /** From a page of this host, or from no page at all, as when another Mirador joins. */
  function refusedSender(request: Request) {
    if (!hasAllowedHost(request)) return new Response("forbidden host", { status: 403 });
    const origin = request.headers.get("origin");
    if (origin !== null && !isPageOrigin(origin)) return new Response("forbidden origin", { status: 403 });
    return null;
  }

  /** A browser joins with the cookie it gets here; an app without cookies keeps the token from the reply. */
  const admittedWith = (request: Request, token: string) => ({ "Set-Cookie": tokenCookie(token, request.headers.get("origin")?.startsWith("https://") ?? false) });

  async function join(request: Request) {
    const refused = refusedSender(request);
    if (refused) return refused;
    const { code, name } = (await request.json().catch(() => ({}))) as { code?: unknown; name?: unknown };
    if (typeof code !== "string") return new Response("The invite code is missing.", { status: 400 });
    const joined = devices.join(code, deviceName(name));
    if (!joined) return new Response("This invite code is wrong, used or expired. Ask for a new one.", { status: 403 });
    sendDevicesToEveryPage();
    return Response.json({ deviceId: joined.device.id, token: joined.token }, { headers: admittedWith(request, joined.token) });
  }

  const askingToJoin = new SenderLimit();
  const sendJoinRequestsToEveryPage = () => hub.broadcast({ type: "join-requests.listed", joinRequests: joinRequests.waiting() });

  async function answerAboutJoining(request: Request, answer: (body: Record<string, unknown>) => Response | Promise<Response>) {
    const refused = refusedSender(request);
    if (refused) return refused;
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    try {
      return await answer(body);
    } catch (error) {
      if (error instanceof JoinRequestRefused) return new Response(error.message, { status: error.status });
      throw error;
    }
  }

  const openJoinRequest = (request: Request, server: Bun.Server<SocketData>) =>
    answerAboutJoining(request, ({ name, commitment, authorityFingerprint }) => {
      const peer = server.requestIP(request)?.address ?? "an unknown address";
      const viaProxyHere = isLoopback(peer);
      const fromAddress = (viaProxyHere && request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim()) || peer;
      const tailscaleUser = viaProxyHere ? request.headers.get("tailscale-user-login") : null;
      if (!askingToJoin.allows(tailscaleUser ?? fromAddress)) throw new JoinRequestRefused(429, "This device asked to join too often. Try again in a minute.");
      return Response.json(joinRequests.open({ name, commitment, authorityFingerprint, fromAddress, tailscaleUser }), { status: 201 });
    });

  const revealJoinRequestNonce = (request: Bun.BunRequest<"/join-requests/:id/reveal">) =>
    answerAboutJoining(request, async ({ secret, nonce }) => {
      const waiting = await joinRequests.reveal(request.params.id, secret, nonce);
      sendJoinRequestsToEveryPage();
      hub.notifyThisComputer(joinRequestNotification(waiting));
      return new Response(null, { status: 204 });
    });

  const pollJoinRequest = (request: Bun.BunRequest<"/join-requests/:id/poll">) =>
    answerAboutJoining(request, ({ secret }) => {
      const answer = joinRequests.poll(request.params.id, secret);
      if (answer.answer === "waiting") return Response.json(answer);
      sendJoinRequestsToEveryPage();
      if (answer.answer === "denied") return Response.json(answer);
      sendDevicesToEveryPage();
      return Response.json(answer, { headers: admittedWith(request, answer.token) });
    });

  const authorityFingerprint = certificate?.authority ? fingerprintOf(certificate.authority) : null;
  function reachabilitySettings(): ReachabilitySettings {
    const running = config.reachability;
    const afterRestart = reachability(process.env, config.dataDir, config.port);
    return {
      publicAddress: running.publicAddress,
      savedPublicAddress: savedPublicAddress(config.dataDir),
      publicAddressSetByEnvironment: running.publicAddressSetByEnvironment,
      network: running.network !== null,
      savedNetwork: savedNetwork(config.dataDir),
      networkSetByEnvironment: running.networkSetByEnvironment,
      networkPort: running.network?.port ?? config.port + 2,
      restartNeeded: JSON.stringify(afterRestart) !== JSON.stringify(running),
      authorityFingerprint,
    };
  }
  const devicesListed = (socket: BrowserSocket): ServerMessage => ({
    type: "devices.listed",
    devices: devices.list(),
    thisDeviceId: socket.data.deviceId,
    reachability: reachabilitySettings(),
  });
  const sendDevicesToEveryPage = () => hub.sendEach(devicesListed);

  /** Saves a setting from Settings for the next start, or says what is wrong with it. */
  function problemSaving(save: () => void) {
    try {
      save();
    } catch (error) {
      return errorMessage(error);
    }
    sendDevicesToEveryPage();
    return null;
  }

  function savePublicAddressFromSettings(address: PublicAddress | null) {
    if (config.reachability.publicAddressSetByEnvironment) throw new Error("The host's environment sets its address, so Settings can't change it.");
    const names = { origin: "Address", canvasOrigin: "Canvas address" };
    savePublicAddress(config.dataDir, address && publicAddressOf(address.origin.trim(), address.canvasOrigin.trim(), names));
  }

  function saveNetworkFromSettings(on: boolean) {
    if (config.reachability.networkSetByEnvironment) throw new Error("The host's environment sets whether it listens on the network, so Settings can't change it.");
    saveNetwork(config.dataDir, on);
  }

  function revokeDevice(deviceId: string) {
    devices.revoke(deviceId);
    hub.disconnectWhere((socket) => socket.data.deviceId === deviceId, "device revoked");
    sendDevicesToEveryPage();
  }

  const broadcastMachines = () => hub.broadcast({ type: "machines.changed", machines: store.listMachines() });

  /** With an invite link, this host joins the machine right away; otherwise its place in the window asks for a code. */
  async function addMachine(name: string, address: string) {
    const parsed = machineAddress(address);
    if (!parsed) throw new Error(`"${address}" is not a machine's address.`);
    const { origin, joinCode, authorityFingerprint } = parsed;
    if (pageOrigins.includes(origin)) throw new Error("That is this machine.");
    if (store.findMachineByOrigin(origin)) throw new Error(`${origin} is already among your machines.`);
    const id = crypto.randomUUID();
    store.insertMachine({ id, name: name.trim() || new URL(origin).hostname, origin, createdAt: Date.now() });
    relays.start(store.findMachine(id)!);
    broadcastMachines();
    if (joinCode) await relays.join(id, joinCode, authorityFingerprint);
  }

  function colorMachine(machineId: string, color: Pastel | null) {
    if (color !== null && !isPastel(color)) throw new Error(`Unknown machine colour ${color}`);
    store.setMachineColor(machineId, color);
    broadcastMachines();
  }

  function removeMachine(machineId: string) {
    relays.stop(machineId);
    watch.stop(machineId);
    store.deleteMachine(machineId);
    broadcastMachines();
  }

  /** Agents and the scripts they start call with the host's token and, unlike a browser's POST, no Origin header. */
  function refusedAgentRequest(request: Request, token: string) {
    if (!hasAllowedHost(request) || request.headers.has("origin")) return new Response("forbidden", { status: 403 });
    const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "");
    return sameSecret(bearer, token) ? null : new Response("unauthorized", { status: 401 });
  }

  function serveMcp(request: Request, conversationId: string) {
    const refused = refusedAgentRequest(request, config.mcpToken);
    if (refused) return refused;
    if (!store.findConversation(conversationId)) return new Response("unknown conversation", { status: 404 });
    return mcp.handle(conversationId, request);
  }

  /** A script knows only the agent session it was started from, so it reaches the conversation running that session. */
  const conversationRunning = (sessionId: string) => store.listConversations().find(({ acpSessionId }) => acpSessionId === sessionId);
  const noConversationRuns = () => new Response("No Mirador conversation runs this agent session.", { status: 404 });

  async function scriptRequestText(request: Request) {
    if (Number(request.headers.get("content-length") ?? 0) > MAX_SCRIPT_MESSAGE_BYTES) return null;
    const text = await request.text();
    return text.length > MAX_SCRIPT_MESSAGE_BYTES ? null : text;
  }

  async function receiveScriptMessage(request: Bun.BunRequest<"/sessions/:sessionId/messages">) {
    const refused = refusedAgentRequest(request, config.scriptToken);
    if (refused) return refused;
    const conversation = conversationRunning(request.params.sessionId);
    if (!conversation) return noConversationRuns();
    const text = await scriptRequestText(request);
    if (text === null) return new Response("message too long", { status: 413 });
    if (!text.trim()) return new Response("empty message", { status: 400 });
    conversations.send(conversation.id, text, [], { fromScript: true }).catch(() => {});
    return Response.json({ conversationId: conversation.id }, { status: 202 });
  }

  /** From `mirador when-done`, which an agent runs after starting a job it leaves running. */
  async function receiveJobWait(request: Bun.BunRequest<"/sessions/:sessionId/job-waits">) {
    const refused = refusedAgentRequest(request, config.scriptToken);
    if (refused) return refused;
    const conversation = conversationRunning(request.params.sessionId);
    if (!conversation) return noConversationRuns();
    const body = await scriptRequestText(request);
    if (body === null) return new Response("message too long", { status: 413 });
    const waitRequest = readJobWaitRequest(parsedJson(body));
    if (typeof waitRequest === "string") return new Response(waitRequest, { status: 400 });
    try {
      const wait = await conversations.waitForJob(conversation.id, waitRequest);
      return Response.json({ conversationId: conversation.id, wait }, { status: 201 });
    } catch (error) {
      return new Response(errorMessage(error), { status: error instanceof JobWaitRefused ? 400 : 500 });
    }
  }

  /** Only the app's own pages, signed in with the browser cookie, may read or add a conversation's images. */
  function refusedImageRequest(request: Request, conversationId: string) {
    if (!hasAllowedHost(request)) return new Response("forbidden host", { status: 403 });
    if (!signedInAs(request)) return new Response("unauthorized", { status: 401 });
    const site = request.headers.get("sec-fetch-site");
    if (site && site !== "same-origin") return new Response("forbidden", { status: 403 });
    if (request.method !== "GET" && !isPageOrigin(request.headers.get("origin"))) return new Response("forbidden origin", { status: 403 });
    if (!store.findConversation(conversationId)) return new Response("unknown conversation", { status: 404 });
    return null;
  }

  async function addImage(request: Bun.BunRequest<"/conversations/:conversationId/images">) {
    const { conversationId } = request.params;
    const refused = refusedImageRequest(request, conversationId);
    if (refused) return refused;
    if (Number(request.headers.get("content-length") ?? 0) > MAX_IMAGE_BYTES) return new Response("image too large", { status: 413 });
    try {
      const imageId = await images.save(conversationId, request.headers.get("content-type") ?? "", await request.arrayBuffer());
      return Response.json({ imageId });
    } catch (error) {
      return new Response(errorMessage(error), { status: 400 });
    }
  }

  async function serveImage(request: Bun.BunRequest<"/conversations/:conversationId/images/:imageId">) {
    const { conversationId, imageId } = request.params;
    const refused = refusedImageRequest(request, conversationId);
    if (refused) return refused;
    const file = isImageId(imageId) ? images.file(conversationId, imageId) : null;
    if (!file || !(await file.exists())) return new Response("not found", { status: 404 });
    return new Response(file, { headers: { "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" } });
  }

  /** The desktop app listens on /notifications with the same token and origin as the pages, and hears only system notifications. */
  function upgradeBrowser(request: Request, server: Bun.Server<SocketData>, role: SocketData["role"]) {
    if (!hasAllowedHost(request)) return new Response("forbidden host", { status: 403 });
    const signedIn = signedInAs(request);
    if (!signedIn) return new Response("unauthorized", { status: 401 });
    if (!isPageOrigin(request.headers.get("origin"))) return new Response("forbidden origin", { status: 403 });
    const upgraded = server.upgrade(request, { data: socketData(role, signedIn.deviceId, canvasAssetsOriginFor(request)) });
    return upgraded ? undefined : new Response("upgrade failed", { status: 400 });
  }

  function deleteConversation(conversationId: string) {
    canvas.withdrawWaitingAsks(conversationId);
    conversations.delete(conversationId);
    mcp.forget(conversationId);
  }

  function moveWorkspace(workspaceId: string, beforeWorkspaceId: string | null) {
    const before = store.listWorkspaces();
    store.setWorkspaceOrder(movedBefore(before.map(({ id }) => id), workspaceId, beforeWorkspaceId));
    const positionBefore = new Map(before.map(({ id, position }) => [id, position]));
    store
      .listWorkspaces()
      .filter(({ id, position }) => positionBefore.get(id) !== position)
      .forEach((workspace) => hub.broadcast({ type: "workspace.upserted", workspace }));
  }

  function savePromptTemplate(draft: Pick<PromptTemplate, "id" | "name" | "text">) {
    const problem = promptTemplateProblem(draft);
    if (problem) throw new Error(problem);
    const { id, name, text } = draft;
    store.savePromptTemplate({ id, name: name.trim(), text, createdAt: Date.now() });
    hub.broadcast({ type: "prompt-template.upserted", template: store.findPromptTemplate(id)! });
  }

  /** Conversations pick it up when their session next starts or resumes. */
  function setCanvasUse(canvasUse: CanvasUse) {
    if (!isCanvasUse(canvasUse)) throw new Error(`Unknown canvas use ${canvasUse}`);
    store.setCanvasUse(canvasUse);
    hub.broadcast({ type: "settings.canvas-use", canvasUse });
  }

  function deletePromptTemplate(templateId: string) {
    store.deletePromptTemplate(templateId);
    hub.broadcast({ type: "prompt-template.deleted", templateId });
  }

  function colorWorkspace(workspaceId: string, color: Pastel | null) {
    if (color !== null && !isPastel(color)) throw new Error(`Unknown workspace colour ${color}`);
    store.setWorkspaceColor(workspaceId, color);
    const workspace = store.findWorkspace(workspaceId);
    if (workspace) hub.broadcast({ type: "workspace.upserted", workspace });
  }

  async function createWorkspace(path: string): Promise<Workspace> {
    const directory = await existingDirectory(path);
    const existing = store.findWorkspaceByPath(directory);
    if (existing) return existing;
    return store.insertWorkspace({
      id: crypto.randomUUID(),
      name: basename(directory) || directory,
      path: directory,
      defaultLaunch: { harness: "claude", profileId: null },
      createdAt: Date.now(),
    });
  }

  async function dispatch(socket: BrowserSocket, message: ClientMessage) {
    const reply = (response: ServerMessage) => hub.send(socket, response);
    switch (message.type) {
      case "workspace.create":
        return hub.broadcast({ type: "workspace.upserted", workspace: await createWorkspace(message.path) });
      case "workspace.delete":
        conversations
          .list()
          .filter((conversation) => conversation.workspaceId === message.workspaceId)
          .forEach((conversation) => deleteConversation(conversation.id));
        terminals.closeWorkspace(message.workspaceId);
        store.deleteWorkspace(message.workspaceId);
        return hub.broadcast({ type: "workspace.deleted", workspaceId: message.workspaceId });
      case "workspace.set-default-launch":
        return profiles.setWorkspaceDefault(message.workspaceId, message.launch);
      case "workspace.move":
        return moveWorkspace(message.workspaceId, message.beforeWorkspaceId);
      case "workspace.set-color":
        return colorWorkspace(message.workspaceId, message.color);
      case "profile.save":
        return reply({ type: "profile.saved", requestId: message.requestId, profileId: profiles.save(message.profile).id });
      case "profile.delete":
        return profiles.delete(message.profileId);
      case "prompt-template.save":
        return savePromptTemplate(message.template);
      case "prompt-template.delete":
        return deletePromptTemplate(message.templateId);
      case "settings.set-canvas-use":
        return setCanvasUse(message.canvasUse);
      case "conversation.create":
        conversations.create(message.workspaceId, message.launch);
        return;
      case "sessions.list":
        conversations
          .listSessionsInWorkspace(message.workspaceId, message.launch)
          .then((sessions) => reply({ type: "sessions.listed", requestId: message.requestId, sessions }))
          .catch((error) => reply({ type: "sessions.failed", requestId: message.requestId, message: errorMessage(error) }));
        return;
      case "mentions.suggest":
        return reply({ type: "mentions.suggested", requestId: message.requestId, suggestions: await conversations.mentionSuggestions(message.conversationId, message.query) });
      case "slash-commands.list":
        return reply({ type: "slash-commands.listed", requestId: message.requestId, commands: conversations.slashCommands(message.conversationId) });
      case "prompt-history.list":
        return reply({ type: "prompt-history.listed", requestId: message.requestId, prompts: conversations.typedElsewhere(message.conversationId) });
      case "conversation.rename":
        return conversations.rename(message.conversationId, message.title);
      case "conversation.set-profile":
        return conversations.setProfile(message.conversationId, message.profileId);
      case "conversation.adopt":
        conversations.adopt(message.workspaceId, message.launch, message.session, message.mode);
        return;
      case "conversation.delete":
        return deleteConversation(message.conversationId);
      case "conversation.move":
        return conversations.move(message.conversationId, message.beforeConversationId);
      case "conversation.subscribe":
        socket.data.subscriptions.add(message.conversationId);
        return reply({
          type: "conversation.history",
          conversationId: message.conversationId,
          events: store.listEvents(message.conversationId),
          canvas: canvas.list(message.conversationId),
        });
      case "conversation.unsubscribe":
        socket.data.subscriptions.delete(message.conversationId);
        return;
      case "conversation.prompt":
        conversations.send(message.conversationId, message.text, message.imageIds, { afterTurn: message.afterTurn }).catch((error) => reply({ type: "error", message: errorMessage(error) }));
        return;
      case "conversation.run-command":
        return conversations.runCommand(message.conversationId, message.command);
      case "conversation.stop-command":
        return conversations.stopCommand(message.conversationId, message.commandId);
      case "conversation.drop-command-outputs":
        return conversations.dropCommandOutputs(message.conversationId, message.commandIds);
      case "conversation.queue.edit":
        return conversations.editQueuedMessage(message.conversationId, message.messageId, message.text);
      case "conversation.queue.move":
        return conversations.moveQueuedMessage(message.conversationId, message.messageId, message.beforeMessageId);
      case "conversation.queue.remove":
        return conversations.removeQueuedMessage(message.conversationId, message.messageId);
      case "conversation.queue.set-after-turn":
        return conversations.setQueuedMessageAfterTurn(message.conversationId, message.messageId, message.afterTurn);
      case "conversation.usage-limit.continue":
        return conversations.continueAfterUsageLimit(message.conversationId);
      case "conversation.usage-limit.stop-waiting":
        return conversations.stopWaitingForUsageLimit(message.conversationId);
      case "conversation.job-wait.stop":
        return conversations.stopWaitingForJob(message.conversationId, message.waitId);
      case "conversation.cancel":
        canvas.withdrawWaitingAsks(message.conversationId);
        return conversations.cancel(message.conversationId);
      case "conversation.set-ask-mode":
        return conversations.setAskMode(message.conversationId, message.askMode);
      case "conversation.set-bypass-permissions":
        return conversations.setBypassPermissions(message.conversationId, message.bypassPermissions);
      case "conversation.set-config":
        return conversations.setConfigOption(message.conversationId, message.configId, message.value);
      case "permission.respond":
        return conversations.respondToPermission(message.conversationId, message.permissionId, message.optionId);
      case "ask.answer":
        return canvas.answer(message.itemId, message.label, message.note);
      case "canvas.report":
        return canvas.reportRender(message.itemId, { errors: message.errors });
      case "review.update-finding":
        return canvas.updateFinding(message.itemId, message.findingId, { decision: message.decision, body: message.body });
      case "review.update-answer":
        return canvas.updateAnswer(message.itemId, message.answerId, { decision: message.decision, body: message.body, resolve: message.resolve });
      case "review.post":
        return canvas.postReview(message.itemId);
      case "review.open-in-editor":
        return canvas.openInEditor(message.itemId, message.path, message.line);
      case "review.read-file":
        canvas
          .readReviewedFile(message.itemId, message.path)
          .then((lines) => reply({ type: "review.file-read", requestId: message.requestId, lines }))
          .catch((error) => reply({ type: "review.file-failed", requestId: message.requestId, message: errorMessage(error) }));
        return;
      case "fs.complete":
        return reply({ type: "fs.completions", requestId: message.requestId, directories: await completeDirectories(message.prefix) });
      case "statusline.render":
        return statusline
          .render(message.conversationId, message.columns, message.runCommand)
          .then((render) => reply({ type: "statusline.rendered", requestId: message.requestId, statusline: render }))
          .catch((error) => reply({ type: "error", message: errorMessage(error) }));
      case "terminals.attach":
        return terminals.attach(socket, message.workspaceId);
      case "terminal.open":
        return reply({ type: "terminal.opened", requestId: message.requestId, ...terminals.open(message.workspaceId, message.columns, message.rows, message.split) });
      case "terminal.open-login": {
        const { workspaceId, program } = conversations.loginProgram(message.conversationId);
        const { exited, ...opened } = terminals.openProgram(workspaceId, message.columns, message.rows, program);
        void exited.then((exitCode) => conversations.loginEnded(message.conversationId, exitCode === 0));
        return reply({ type: "terminal.opened", requestId: message.requestId, ...opened });
      }
      case "terminal.replay":
        return terminals.replay(socket, message.terminalId);
      case "terminal.input":
        return terminals.input(message.terminalId, message.data);
      case "terminal.resize":
        return terminals.resize(message.terminalId, message.columns, message.rows);
      case "terminal.close":
        return message.unlessBusy ? terminals.closeUnlessBusy(socket, message.terminalId) : terminals.close(message.terminalId);
      case "terminal.close-tab":
        return terminals.closeTab(message.tabId);
      case "presence":
        socket.data.presence = { conversationId: message.conversationId, attentive: message.attentive };
        if (message.attentive && message.conversationId) conversations.markSeen(message.conversationId);
        return;
      case "terminal.clear":
        return terminals.clear(message.terminalId);
      case "host.restart":
        return restart.restart();
      case "devices.list":
        return hub.send(socket, devicesListed(socket));
      case "devices.invite":
        return hub.send(socket, { type: "devices.invited", requestId: message.requestId, ...devices.invite() });
      case "device.revoke":
        return revokeDevice(message.deviceId);
      case "settings.set-public-address":
        return reply({ type: "settings.saved", requestId: message.requestId, problem: problemSaving(() => savePublicAddressFromSettings(message.address)) });
      case "settings.set-network":
        return reply({ type: "settings.saved", requestId: message.requestId, problem: problemSaving(() => saveNetworkFromSettings(message.on)) });
      case "machine.add":
        return await addMachine(message.name, message.address);
      case "machine.remove":
        return removeMachine(message.machineId);
      case "machine.set-color":
        return colorMachine(message.machineId, message.color);
      case "join-request.approve": {
        const problem = await joinRequests.approve(message.joinRequestId, message.number).then(
          (approved) => (approved ? null : "That is not the number the device shows, so its request was denied. It can ask again."),
          errorMessage,
        );
        sendJoinRequestsToEveryPage();
        return reply({ type: "join-request.answered", requestId: message.requestId, problem });
      }
      case "join-request.deny":
        joinRequests.deny(message.joinRequestId);
        return sendJoinRequestsToEveryPage();
      case "machine.ask-to-join":
        return void relays
          .askToJoin(message.machineId, (number) => reply({ type: "machine.join-asked", requestId: message.requestId, number }))
          .then(() => null, errorMessage)
          .then((problem) => reply({ type: "machine.join-answered", requestId: message.requestId, problem }));
      case "machine.join": {
        const problem = await relays.join(message.machineId, message.code, message.authorityFingerprint).then(() => null, errorMessage);
        return reply({ type: "machine.join-answered", requestId: message.requestId, problem });
      }
      case "search":
        return reply({ type: "search.results", requestId: message.requestId, conversations: search.find(message.query) });
      default:
        return message satisfies never;
    }
  }

  /** All the network listener serves: what pages of other devices use. */
  const routesForDevices = {
    "/": index,
    "/join": { POST: join },
    "/join-requests": { POST: openJoinRequest },
    "/join-requests/:id/reveal": { POST: revealJoinRequestNonce },
    "/join-requests/:id/poll": { POST: pollJoinRequest },
    "/conversations/:conversationId/images": { POST: addImage },
    "/conversations/:conversationId/images/:imageId": { GET: serveImage },
    "/mirador-ca.pem": serveAuthority,
  };
  /** Only this machine's own browser, agents and scripts sign in with these tokens, so they are served on 127.0.0.1 alone. */
  const routesForThisMachine = {
    "/auth": authenticate,
    "/mcp/:conversationId": (request: Bun.BunRequest<"/mcp/:conversationId">) => serveMcp(request, request.params.conversationId),
    "/sessions/:sessionId/messages": { POST: receiveScriptMessage },
    "/sessions/:sessionId/job-waits": { POST: receiveJobWait },
  };

  function upgradeSockets(request: Request, server: Bun.Server<SocketData>) {
    const { pathname } = new URL(request.url);
    if (pathname === "/ws") return upgradeBrowser(request, server, "page");
    if (pathname === "/notifications") return upgradeBrowser(request, server, "notifier");
    return new Response("not found", { status: 404 });
  }

  const websocket: Bun.WebSocketHandler<SocketData> = {
    /** Bun drops what is sent while more than the limit waits to go out (16 MB by default, less than one long history), so the limit is far above that, and a client that falls further behind is disconnected to reconnect and fetch again instead of silently missing messages. */
    backpressureLimit: 1024 * 1024 * 1024,
    closeOnBackpressureLimit: true,
    open(socket) {
      hub.add(socket);
      if (socket.data.deviceId) devices.seen(socket.data.deviceId);
      if (socket.data.role === "notifier") return;
      hub.send(socket, {
        type: "snapshot",
        workspaces: store.listWorkspaces(),
        conversations: conversations.list(),
        profiles: store.listProfiles(),
        promptTemplates: store.listPromptTemplates(),
        canvasUse: store.canvasUse(),
        canvasAssetsOrigin: socket.data.canvasAssetsOrigin,
        agentsCanvasAssetsOrigin: config.canvasAssetsOrigin,
        machines: store.listMachines(),
        machineStatuses: watch.statuses(),
        homeDir: homedir(),
        hostRunId,
        hostCodeChanged: restart.codeChanged,
      });
      hub.send(socket, { type: "join-requests.listed", joinRequests: joinRequests.waiting() });
    },
    close(socket, code, reason) {
      hub.remove(socket);
      if (code !== 1000 && code !== 1001) console.log(`${new Date().toISOString()} browser socket closed: ${code} ${reason}`);
    },
    async message(socket, raw) {
      if (socket.data.role === "notifier") return;
      try {
        await dispatch(socket, JSON.parse(String(raw)) as ClientMessage);
      } catch (error) {
        hub.send(socket, { type: "error", message: errorMessage(error) });
      }
    },
  };

  const options = serveOptions({
    hostname: "127.0.0.1",
    port: config.port,
    idleTimeout: 0,
    development: config.developmentMode,
    routes: { ...routesForDevices, ...routesForThisMachine },
    fetch: upgradeSockets,
    websocket,
  });
  const networkOptions =
    network && certificate
      ? serveOptions({
          hostname: "0.0.0.0",
          port: network.port,
          tls: { cert: certificate.chain, key: certificate.key },
          idleTimeout: 0,
          development: config.developmentMode,
          routes: routesForDevices,
          fetch: upgradeSockets,
          websocket,
        })
      : null;
  const server = Bun.serve(options);
  const networkServer = networkOptions && Bun.serve(networkOptions);
  /** The page bundle is built once per set of routes, so setting the same routes again rebuilds it from the current source. */
  const rebuildUi = () => {
    server.reload(options);
    if (networkServer && networkOptions) networkServer.reload(networkOptions);
  };
  const stop = () => {
    server.stop(true);
    networkServer?.stop(true);
  };
  return { stop, rebuildUi };
}

/** Types the options where they are written, so they can be passed to both Bun.serve and server.reload. */
function serveOptions<R extends string>(options: Bun.Serve.Options<SocketData, R>) {
  return options;
}
