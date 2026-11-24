# The same .env docker compose reads, so `make verify` checks the ports the
# stack is actually bound to rather than the defaults.
-include .env
export

REGISTRY   := registry.leviathan.systems
PROJECT    := logerhub
TAG        ?= latest
# Pinned, because the server is amd64: an image built on an arm64 workstation
# would push happily and then refuse to start there.
PLATFORM   ?= linux/amd64

# docker-compose.yml names both images from these, so compose can push and pull
# them. Override on the command line: `make build TAG=release`.
export REGISTRY PROJECT TAG

.PHONY: help build push release pull deploy logs down verify
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
	@echo '    make pull            pull the images, no build'
	@echo '    make deploy          pull, then restart the stack'
	@echo '    make logs            follow the gateway and console logs'
	@echo ''
	@echo '  TAG=$(TAG)  REGISTRY=$(REGISTRY)  PROJECT=$(PROJECT)'

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
	@printf 'ingest  '; curl -fsS -o /dev/null -w '%{http_code}\n' http://$(or $(INGEST_BIND),127.0.0.1:8080)/health || echo 'unreachable'
	@printf 'console '; curl -fsS -o /dev/null -w '%{http_code}\n' http://$(or $(WEB_BIND),127.0.0.1:3000)/login || echo 'unreachable'

logs:
	docker compose logs -f ingest web

down:
	docker compose down
