.DEFAULT_GOAL := help
SHELL := bash
DIST := $(CURDIR)/dist
MAC_ARCH := $(shell uname -m | sed 's/x86_64/x64/')
SHA256 := $(shell command -v sha256sum || echo shasum -a 256)
LINUX_HOST ?=
REMOTE_DIR ?= mirador-release
REMOTE_TMPDIR ?= $$HOME/mirador-release-tmp

.PHONY: help macos linux linux-x64 linux-arm64 linux-remote checksums clean

help: ## List the goals (builds take the committed files only)
	@grep -E '^[a-z0-9 -]+:.*## ' $(MAKEFILE_LIST) | sed -E 's/:.*## /\t/' | awk -F'\t' '{printf "  make %-14s %s\n", $$1, $$2}'

macos: ## The macOS app with Mirador inside, zipped into dist/ (on a Mac)
	@[ "$$(uname -s)" = Darwin ] || { echo "make macos needs a Mac" >&2; exit 2; }
	cd desktop && bun install --frozen-lockfile && bun run build:release
	mkdir -p $(DIST) && rm -f $(DIST)/Mirador-macos-$(MAC_ARCH).zip
	ditto -c -k --keepParent desktop/build/stable-macos-$(MAC_ARCH)/Mirador.app $(DIST)/Mirador-macos-$(MAC_ARCH).zip

linux: linux-x64 linux-arm64 ## Both Linux installers (or one: linux-x64, linux-arm64), built, installed and checked in containers, into dist/ (on an x64 Linux machine)

linux-x64 linux-arm64: linux-%:
	@[ "$$(uname -s)" = Linux ] || { echo "Build the Linux installers on an x64 Linux machine, as Electrobun's toolchain crashes in Docker on Apple Silicon; from a Mac: make linux-remote LINUX_HOST=user@host" >&2; exit 2; }
	MIRADOR_LINUX_ARCH=$* MIRADOR_LINUX_RELEASE=1 scripts/linux-desktop.sh
	mkdir -p $(DIST)
	cp "$${TMPDIR:-/tmp}/mirador-linux-desktop-$*-release/linux-$*-Mirador-Setup.tar.gz" $(DIST)/Mirador-linux-$*-Setup.tar.gz

linux-remote: ## From a Mac: make linux on LINUX_HOST=user@host, with the installers copied back into dist/
	@[ -n "$(LINUX_HOST)" ] || { echo "Name the x64 Linux machine: make linux-remote LINUX_HOST=user@host" >&2; exit 2; }
	@git diff --quiet HEAD || echo "Uncommitted changes stay out of the build: sending HEAD ($$(git rev-parse --short HEAD))" >&2
	git bundle create - HEAD --tags | ssh $(LINUX_HOST) 'cat > $(REMOTE_DIR).bundle'
	ssh $(LINUX_HOST) 'set -e; bundle=$$(realpath $(REMOTE_DIR).bundle); mkdir -p $(REMOTE_DIR) $(REMOTE_TMPDIR); cd $(REMOTE_DIR); git init -q; git config core.ignorecase false; git fetch -q --force --tags "$$bundle" HEAD; rm -f "$$bundle"; git checkout -qf --detach FETCH_HEAD; git clean -qfdx -e /dist/; TMPDIR=$(REMOTE_TMPDIR) make linux'
	mkdir -p $(DIST)
	rsync -a '$(LINUX_HOST):$(REMOTE_DIR)/dist/Mirador-linux-*-Setup.tar.gz' $(DIST)/

checksums: ## The SHA-256 of what dist/ holds, for the release notes
	@cd $(DIST) && $(SHA256) Mirador-*

clean: ## Empty dist/
	rm -rf $(DIST)
