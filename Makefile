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

.PHONY: help env build push release pull deploy logs down verify
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

verify:
	@sleep 5
	@printf 'ingest  '; curl -fsS -o /dev/null -w '%{http_code}\n' "http://$(INGEST_ADDR)/health" || echo 'unreachable'
	@printf 'console '; curl -fsS -o /dev/null -w '%{http_code}\n' "http://$(WEB_ADDR)/login" || echo 'unreachable'

logs:
	docker compose logs -f ingest web

down:
	docker compose down
