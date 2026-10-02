# Sourced by the Linux scripts. MIRADOR_LINUX_ARCH picks the architecture to build and run on, x64 or arm64. It defaults
# to this machine's; the other one runs emulated, several times slower.
arch=${MIRADOR_LINUX_ARCH:-$(uname -m | sed 's/x86_64/x64/; s/aarch64/arm64/')}
case "$arch" in
  x64) platform=linux/amd64 ;;
  arm64) platform=linux/arm64 ;;
  *) echo "MIRADOR_LINUX_ARCH must be x64 or arm64, not $arch" >&2; exit 2 ;;
esac

# Images and the Bun cache are kept per architecture, so building for one never replaces the other.
build_image() {
  docker build --quiet --platform "$platform" --build-arg "ARCH=$arch" --tag "mirador-$1-$arch" \
    --file "$repo/scripts/$1.Dockerfile" "$repo/scripts" >/dev/null
}

# Rootless Podman (Fedora's `docker`) maps your user to root in the container, which leaves the container's user unable
# to write the results; map you to that user (ubuntu, uid 1000) instead.
userns=()
[[ $(docker --version 2>/dev/null) == *[Pp]odman* ]] && userns=(--userns=keep-id:uid=1000,gid=1000)

run_in_container() {
  docker run --rm --init --platform "$platform" ${userns[@]+"${userns[@]}"} \
    --volume "$repo:/src:ro" \
    --volume "mirador-linux-bun-cache-$arch:/home/ubuntu/.bun/install/cache" \
    "$@"
}
