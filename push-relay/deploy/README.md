# Running the push relay

The relay and Caddy share one pod, so only Caddy is reachable from outside; Caddy gets the
certificate from Let's Encrypt and passes requests to the relay on the pod's localhost.

```sh
podman build -f push-relay/Containerfile -t mirador-push-relay .
mkdir -p ~/mirador-push-relay/{data,secrets,caddy}   # secrets: mode 700, its files mode 600
podman pod create --name mirador-push-relay --userns=keep-id:uid=1000,gid=1000 -p <high port>:443 -p <high port + 1>:80
podman run -d --pod mirador-push-relay --name mirador-push-relay-caddy \
  -e PUSH_RELAY_DOMAIN=push.example.com \
  -v ./push-relay/deploy/Caddyfile:/etc/caddy/Caddyfile:ro,Z -v ~/mirador-push-relay/caddy:/data:Z \
  docker.io/library/caddy:2
podman run -d --pod mirador-push-relay --name mirador-push-relay-app \
  -v ~/mirador-push-relay/data:/data:Z -v ~/mirador-push-relay/secrets:/secrets:ro,Z \
  -e APNS_KEY_FILE=/secrets/apns.p8 -e APNS_KEY_ID=… -e APNS_TEAM_ID=… -e APNS_TOPIC=… \
  -e FCM_SERVICE_ACCOUNT_FILE=/secrets/firebase.json \
  mirador-push-relay
```

The relay runs as uid 1000 (`bun`); `keep-id` maps the owner's user to it, so the relay can
write `data/tokens` and read the mode-600 secrets the owner put in place.

The router forwards public 443 (and 80, for the certificate's HTTP challenge) to the two high ports.

A token for each Mac, printed once:

```sh
podman exec mirador-push-relay-app bun push-relay/main.ts token add studio-mac
```

`token list` and `token remove <label>` manage them; a removed token stops working at once.
