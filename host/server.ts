import { timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { basename } from "node:path";
import index from "../web/index.html";
import type { Workspace } from "../shared/model.ts";
import type { ClientMessage, ServerMessage } from "../shared/protocol.ts";
import type { CanvasMcpEndpoints } from "./canvas/mcp.ts";
import type { CanvasService } from "./canvas/service.ts";
import type { HostConfig } from "./config.ts";
import { errorMessage, type ConversationService } from "./conversations.ts";
import type { BrowserSocket, Hub, SocketData } from "./hub.ts";
import { completeDirectories, existingDirectory } from "./paths.ts";
import type { ProfileService } from "./profiles.ts";
import type { StatuslineService } from "./statusline.ts";
import type { Store } from "./store.ts";
import type { TerminalService } from "./terminals.ts";

const TOKEN_COOKIE = "mirador_token";

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
}

function sameSecret(candidate: string | null | undefined, secret: string) {
  if (!candidate) return false;
  const [a, b] = [Buffer.from(candidate), Buffer.from(secret)];
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieValue(request: Request, name: string) {
  const cookies = request.headers.get("cookie") ?? "";
  return cookies
    .split(";")
    .map((part) => part.trim().split("="))
    .find(([key]) => key === name)?.[1];
}

export function startServer(services: HostServices) {
  const { config, store, hub, conversations, canvas, mcp, profiles, statusline, terminals } = services;
  const allowedHosts = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`]);
  const hasAllowedHost = (request: Request) => allowedHosts.has(request.headers.get("host") ?? "");

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
        "Set-Cookie": `${TOKEN_COOKIE}=${config.browserToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
      },
    });
  }

  function serveMcp(request: Request, conversationId: string) {
    if (!hasAllowedHost(request) || request.headers.has("origin")) return new Response("forbidden", { status: 403 });
    const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "");
    if (!sameSecret(bearer, config.mcpToken)) return new Response("unauthorized", { status: 401 });
    if (!store.findConversation(conversationId)) return new Response("unknown conversation", { status: 404 });
    return mcp.handle(conversationId, request);
  }

  function upgradeBrowser(request: Request, server: Bun.Server<SocketData>) {
    if (!hasAllowedHost(request)) return new Response("forbidden host", { status: 403 });
    if (!sameSecret(cookieValue(request, TOKEN_COOKIE), config.browserToken)) {
      return new Response("unauthorized", { status: 401 });
    }
    if (request.headers.get("origin") !== config.appOrigin) return new Response("forbidden origin", { status: 403 });
    const upgraded = server.upgrade(request, { data: { subscriptions: new Set<string>(), terminalWorkspaceId: null } });
    return upgraded ? undefined : new Response("upgrade failed", { status: 400 });
  }

  function deleteConversation(conversationId: string) {
    canvas.withdrawWaitingAsks(conversationId);
    conversations.delete(conversationId);
    mcp.forget(conversationId);
  }

  async function createWorkspace(path: string): Promise<Workspace> {
    const directory = await existingDirectory(path);
    const existing = store.findWorkspaceByPath(directory);
    if (existing) return existing;
    const workspace: Workspace = {
      id: crypto.randomUUID(),
      name: basename(directory) || directory,
      path: directory,
      defaultLaunch: { harness: "claude", profileId: null },
      createdAt: Date.now(),
    };
    store.insertWorkspace(workspace);
    return workspace;
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
      case "profile.save":
        return reply({ type: "profile.saved", requestId: message.requestId, profileId: profiles.save(message.profile).id });
      case "profile.delete":
        return profiles.delete(message.profileId);
      case "conversation.create":
        conversations.create(message.workspaceId, message.launch);
        return;
      case "sessions.list":
        conversations
          .listSessionsInWorkspace(message.workspaceId, message.launch)
          .then((sessions) => reply({ type: "sessions.listed", requestId: message.requestId, sessions }))
          .catch((error) => reply({ type: "sessions.failed", requestId: message.requestId, message: errorMessage(error) }));
        return;
      case "conversation.rename":
        return conversations.rename(message.conversationId, message.title);
      case "conversation.set-profile":
        return conversations.setProfile(message.conversationId, message.profileId);
      case "conversation.adopt":
        conversations.adopt(message.workspaceId, message.launch, message.session, message.mode);
        return;
      case "conversation.delete":
        return deleteConversation(message.conversationId);
      case "conversation.subscribe":
        socket.data.subscriptions = new Set([message.conversationId]);
        return reply({
          type: "conversation.history",
          conversationId: message.conversationId,
          events: store.listEvents(message.conversationId),
          canvas: canvas.list(message.conversationId),
        });
      case "conversation.prompt":
        conversations.send(message.conversationId, message.text).catch((error) => reply({ type: "error", message: errorMessage(error) }));
        return;
      case "conversation.run-command":
        return conversations.runCommand(message.conversationId, message.command);
      case "conversation.stop-command":
        return conversations.stopCommand(message.conversationId, message.commandId);
      case "conversation.drop-command-outputs":
        return conversations.dropCommandOutputs(message.conversationId, message.commandIds);
      case "conversation.queue.edit":
        return conversations.editQueuedMessage(message.conversationId, message.messageId, message.text);
      case "conversation.queue.remove":
        return conversations.removeQueuedMessage(message.conversationId, message.messageId);
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
        return reply({ type: "terminal.opened", requestId: message.requestId, ...terminals.open(message.workspaceId, message.columns, message.rows, message.tabId) });
      case "terminal.replay":
        return terminals.replay(socket, message.terminalId);
      case "terminal.input":
        return terminals.input(message.terminalId, message.data);
      case "terminal.resize":
        return terminals.resize(message.terminalId, message.columns, message.rows);
      case "terminal.close":
        return terminals.close(message.terminalId);
      case "terminal.close-tab":
        return terminals.closeTab(message.tabId);
      default:
        return message satisfies never;
    }
  }

  return Bun.serve<SocketData>({
    hostname: "127.0.0.1",
    port: config.port,
    idleTimeout: 0,
    development: config.developmentMode,
    routes: {
      "/": index,
      "/auth": authenticate,
      "/mcp/:conversationId": (request: Bun.BunRequest<"/mcp/:conversationId">) => serveMcp(request, request.params.conversationId),
    },
    fetch(request, server) {
      if (new URL(request.url).pathname === "/ws") return upgradeBrowser(request, server);
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(socket) {
        hub.add(socket);
        hub.send(socket, {
          type: "snapshot",
          workspaces: store.listWorkspaces(),
          conversations: conversations.list(),
          profiles: store.listProfiles(),
          canvasAssetsOrigin: config.canvasAssetsOrigin,
          homeDir: homedir(),
        });
      },
      close(socket, code, reason) {
        hub.remove(socket);
        if (code !== 1000 && code !== 1001) console.log(`${new Date().toISOString()} browser socket closed: ${code} ${reason}`);
      },
      async message(socket, raw) {
        try {
          await dispatch(socket, JSON.parse(String(raw)) as ClientMessage);
        } catch (error) {
          hub.send(socket, { type: "error", message: errorMessage(error) });
        }
      },
    },
  });
}
