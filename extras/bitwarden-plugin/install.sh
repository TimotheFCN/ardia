#!/bin/sh
set -eu

usage() {
  echo "usage: $0 [--data-dir DIR] [--rbw PATH]" >&2
  echo "  --data-dir DIR  the instance's ARDIA_DATA_DIR (pnpm macos: \"\$HOME/Library/Application Support/Ardia Dev\")" >&2
  echo "  --rbw PATH      an rbw-ng checkout to build, instead of cloning its embedded branch" >&2
  exit 2
}

here=$(cd "$(dirname "$0")" && pwd)
data_dir=""
rbw=""
while [ $# -gt 0 ]; do
  case "$1" in
    --data-dir) [ $# -ge 2 ] || usage; data_dir=$2; shift 2 ;;
    --rbw) [ $# -ge 2 ] || usage; rbw=$2; shift 2 ;;
    *) usage ;;
  esac
done

if [ -n "$data_dir" ]; then
  config="$data_dir/config"
else
  config="${XDG_CONFIG_HOME:-$HOME/.config}/ardia"
fi

command -v cargo >/dev/null || { echo "Rust is needed: https://rustup.rs" >&2; exit 1; }

if [ -z "$rbw" ]; then
  rbw="$here/.build/rbw-ng"
  ref="${RBW_NG_REF:-embedded}"
  if [ ! -d "$rbw/.git" ]; then
    mkdir -p "$here/.build"
    git clone --quiet https://github.com/TimotheFCN/rbw-ng "$rbw"
  fi
  git -C "$rbw" fetch --quiet origin "$ref"
  git -C "$rbw" checkout --quiet --detach FETCH_HEAD
fi

cargo build --release --manifest-path "$rbw/Cargo.toml" --bin rbw-agent --no-default-features
cargo build --release --manifest-path "$here/bridge/Cargo.toml"

plugin="$config/plugins/bitwarden"
mkdir -p "$plugin/bin"
cp "$here/plugin.json" "$plugin/plugin.json"
install -m 755 "$rbw/target/release/rbw-agent" "$plugin/bin/rbw-agent"
install -m 755 "$here/bridge/target/release/bitwarden-bridge" "$plugin/bin/bitwarden-bridge"

echo "Installed the Bitwarden plugin in $plugin"
echo "In Ardia: Settings > Plugins > Bitwarden > Turn On, then Settings > Profiles > Passwords > Password manager > Bitwarden."
