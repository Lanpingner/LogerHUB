# The same .env docker compose reads, so `make verify` checks the ports the
# stack is actually bound to rather than the defaults. Only the two bind
# addresses are taken from it, and nothing from it is exported: .env also holds
# CONSOLE_SECRET and SESSION_SECRET, and a bare `export` would hand those to
# every command make runs, including ones that have no business seeing them.
# Compose reads .env itself, so it loses nothing.
INGEST_BIND := $(strip $(shell sed -n 's/^INGEST_BIND=//p' .env 2>/dev/null | tail -1))
WEB_BIND    := $(strip $(shell sed -n 's/^WEB_BIND=//p' .env 2>/dev/null | tail -1))

# host:port only. A value from a file is not a command, and interpolating one
# unchecked into a shell recipe is how a stray character becomes an executed one.
VALID_BIND  := ^[A-Za-z0-9._-]+:[0-9]+$$
INGEST_ADDR := $(shell printf %s '$(INGEST_BIND)' | grep -Eq '$(VALID_BIND)' && printf %s '$(INGEST_BIND)' || printf 127.0.0.1:8080)
WEB_ADDR    := $(shell printf %s '$(WEB_BIND)' | grep -Eq '$(VALID_BIND)' && printf %s '$(WEB_BIND)' || printf 127.0.0.1:3000)

REGISTRY   := registry.leviathan.systems
PROJECT    := logerhub
TAG        ?= latest
# Pinned, because the server is amd64: an image built on an arm64 workstation
# would push happily and then refuse to start there.
PLATFORM   ?= linux/amd64

# docker-compose.yml names both images from these, so compose can push and pull
# them. Override on the command line: `make build TAG=release`.
export REGISTRY PROJECT TAG

.PHONY: help env build push release pull deploy logs down verify cert tls-up

# The address a browser will type. `make cert HOST=203.0.113.4` or
# HOST=logs.example.com. Validated below before it reaches a shell: a hostname
# is data, and interpolating one unchecked into a recipe executes it.
HOST ?=
VALID_HOST := ^[A-Za-z0-9.:_-]+$$
.DEFAULT_GOAL := help

help:
	@echo 'Build on a workstation, run on the server. The server never builds:'
	@echo '`next build` needs ~2GB and the registry is faster than npm there.'
	@echo ''
	@echo '  On your workstation:'
	@echo '    make build           build both images for $(PLATFORM)'
	@echo '    make push            push them to $(REGISTRY)/$(PROJECT)'
	@echo '    make release         build + push, tagged `release`'
	@echo ''
	@echo '  On the server:'
	@echo '    make env             create .env with fresh secrets (once)'
	@echo '    make pull            pull the images, no build'
	@echo '    make deploy          pull, then restart the stack'
	@echo '    make logs            follow the gateway and console logs'
	@echo ''
	@echo '  HTTPS without a domain (reached by IP):'
	@echo '    make cert HOST=1.2.3.4   self-signed certificate for that address'
	@echo '    make tls-up              start the stack with nginx on 80/443'
	@echo ''
	@echo '  TAG=$(TAG)  REGISTRY=$(REGISTRY)  PROJECT=$(PROJECT)'

# Never touches an existing .env: those secrets sign operator sessions and the
# console's calls to the gateway, so regenerating them silently would log
# everyone out and break that pair.
env:
	@if [ -e .env ]; then \
		echo '.env already exists — leaving it alone.'; \
	else \
		command -v openssl >/dev/null 2>&1 || { echo 'openssl is not installed; .env not created.' >&2; exit 1; }; \
		cs=$$(openssl rand -hex 32); ss=$$(openssl rand -hex 32); \
		case "$$cs$$ss" in *[!0-9a-f]*|"") echo 'openssl produced no usable secret; .env not created.' >&2; exit 1;; esac; \
		[ $${#cs} -ge 32 ] && [ $${#ss} -ge 32 ] || { echo 'openssl produced a short secret; .env not created.' >&2; exit 1; }; \
		umask 077 && cp .env.example .env.new && \
		sed -i "s|^CONSOLE_SECRET=.*|CONSOLE_SECRET=$$cs|" .env.new && \
		sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=$$ss|" .env.new && \
		grep -q "^CONSOLE_SECRET=$$cs$$" .env.new && grep -q "^SESSION_SECRET=$$ss$$" .env.new || \
			{ echo 'the secrets were not written; .env not created (see .env.new).' >&2; exit 1; }; \
		mv .env.new .env && \
		echo '.env created with fresh secrets. Check INGEST_BIND and WEB_BIND before deploying.'; \
	fi

build:
	DOCKER_DEFAULT_PLATFORM=$(PLATFORM) docker compose build ingest web

push: build
	docker compose push ingest web

release:
	$(MAKE) push TAG=release

# --- on the server ---------------------------------------------------------

# Every service, not just the two we build: Loki comes from Docker Hub, and on a
# fresh server `up` would otherwise fetch it mid-start, which looks like a hang.
# Pulling it here keeps all the downloading in the step named "pull".
pull:
	docker compose pull

# `--no-build` is the point: the server has the images and must never try to
# build them. Loki comes from Docker Hub as usual.
deploy: pull
	docker compose up -d --no-build
	@echo ''
	@$(MAKE) --no-print-directory verify

# --- HTTPS with no domain --------------------------------------------------

# A self-signed certificate for an address. Browsers will warn once; what it
# buys is that the session cookie and the password stop crossing the network in
# clear text, which is what COOKIE_INSECURE=1 gives up.
#
# The address goes in subjectAltName, not just the subject: a certificate with
# only a CN is rejected outright by every current browser, and for an IP the
# entry has to be IP:, not DNS:, or it will not match either.
cert:
	@printf %s '$(HOST)' | grep -Eq '$(VALID_HOST)' || \
		{ echo 'Set HOST to the address a browser will use: make cert HOST=1.2.3.4' >&2; exit 1; }
	@command -v openssl >/dev/null 2>&1 || { echo 'openssl is not installed.' >&2; exit 1; }
	@if [ -e deploy/certs/logerhub.key ]; then \
		echo 'deploy/certs/logerhub.key already exists — delete it to issue a new one.'; \
	else \
		case '$(HOST)' in \
			*[!0-9.:]*) san='DNS:$(HOST)';; \
			*) san='IP:$(HOST)';; \
		esac; \
		mkdir -p deploy/certs && umask 077 && \
		openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
			-keyout deploy/certs/logerhub.key \
			-out deploy/certs/logerhub.crt \
			-subj '/CN=$(HOST)' -addext "subjectAltName=$$san" >/dev/null 2>&1 && \
		chmod 644 deploy/certs/logerhub.crt && \
		echo "certificate issued for $$san, valid 10 years:" && \
		openssl x509 -in deploy/certs/logerhub.crt -noout -subject -ext subjectAltName; \
	fi

# nginx is the only public service, so the two app ports go back to loopback.
# Without that they stay reachable on plain HTTP and the TLS is decoration.
tls-up:
	@[ -e deploy/certs/logerhub.crt ] || { echo 'No certificate yet: make cert HOST=<address>' >&2; exit 1; }
	@grep -Eq '^(INGEST|WEB)_BIND=0\.0\.0\.0' .env 2>/dev/null && \
		echo 'WARNING: .env still binds a service to 0.0.0.0 — set both to 127.0.0.1 so only nginx is public.' || true
	docker compose --profile nginx up -d
	@echo ''
	@printf 'https  '; curl -fsSk -o /dev/null -w '%{http_code}\n' "https://$(if $(HOST),$(HOST),localhost)/login" || echo 'unreachable'

verify:
	@sleep 5
	@printf 'ingest  '; curl -fsS -o /dev/null -w '%{http_code}\n' "http://$(INGEST_ADDR)/health" || echo 'unreachable'
	@printf 'console '; curl -fsS -o /dev/null -w '%{http_code}\n' "http://$(WEB_ADDR)/login" || echo 'unreachable'

logs:
	docker compose logs -f ingest web

down:
	docker compose down
