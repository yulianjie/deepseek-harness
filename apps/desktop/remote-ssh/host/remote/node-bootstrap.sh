fail_login_node() {
  printf 'DSH_REMOTE_SSH_RESULT {"code":"%s","error":"%s"}\n' "${2:-REMOTE_LOGIN_PROBE_FAILED}" "$1"
  exit 0
}

[ "$(uname -s)" = Linux ] || fail_login_node 'The remote Harness Host requires Linux.' REMOTE_LINUX_REQUIRED
case "${SHELL:-}" in
  /*) [ -x "$SHELL" ] || fail_login_node 'The SSH login shell is unavailable.' ;;
  *) fail_login_node 'The SSH account did not provide an absolute login shell path.' ;;
esac
[ -x /usr/bin/script ] && [ -x /usr/bin/timeout ] ||
  fail_login_node 'Resolving Node.js from the SSH login terminal requires util-linux script and coreutils timeout.'

# Give login startup a terminal, but never give it the deployment stdin.
# Only the two probe values leave the PTY, through a private file descriptor.
login_probe=$(mktemp) || fail_login_node 'Could not create the private SSH login probe.'
trap 'rm -f -- "$login_probe"' EXIT
DSH_REMOTE_LOGIN_SHELL=$SHELL
DSH_REMOTE_LOGIN_PROBE='printf "%s\n%s\n%s\n" "$PATH" "$(command -v node)" DSH_LOGIN_PROBE_DONE >&3'
export DSH_REMOTE_LOGIN_SHELL DSH_REMOTE_LOGIN_PROBE
if ! SHELL=/bin/sh /usr/bin/timeout -k 2 20 /usr/bin/script -q -e -c '
  SHELL=$DSH_REMOTE_LOGIN_SHELL
  export SHELL
  if [ -n "${SSH_CONNECTION:-}" ]; then
    SSH_TTY=$(/usr/bin/tty) && export SSH_TTY
  fi
  exec "$SHELL" -ilc "$DSH_REMOTE_LOGIN_PROBE" "-${SHELL##*/}"
' /dev/null </dev/null 3>"$login_probe" >/dev/null 2>&1; then
  fail_login_node 'Could not probe the interactive SSH login shell. Check that its startup supports a scripted terminal.'
fi
unset DSH_REMOTE_LOGIN_SHELL DSH_REMOTE_LOGIN_PROBE
if ! { IFS= read -r login_path && IFS= read -r remote_node && IFS= read -r marker; } < "$login_probe" ||
   [ "$marker" != DSH_LOGIN_PROBE_DONE ]; then
  fail_login_node 'The interactive SSH login shell did not return a valid Node.js selection.'
fi
rm -f -- "$login_probe"
trap - EXIT

case "$remote_node" in
  /*) [ -f "$remote_node" ] && [ -x "$remote_node" ] ||
    fail_login_node 'Node.js on the SSH login terminal is not an executable file.' REMOTE_NODE_REQUIRED ;;
  '') fail_login_node 'Node.js was not found in the SSH login terminal.' REMOTE_NODE_REQUIRED ;;
  *) fail_login_node 'Node.js must resolve to an executable path in the SSH login terminal.' REMOTE_NODE_REQUIRED ;;
esac
case ":$login_path:" in
  *::*|*:[!/]*) fail_login_node 'The SSH login terminal PATH must contain absolute directories to keep Node.js selection independent of the working directory.' ;;
esac
export PATH=$login_path
[ "$(command -v node)" = "$remote_node" ] ||
  fail_login_node 'Node.js in the SSH login terminal must be the executable resolved by its PATH.' REMOTE_NODE_REQUIRED

# Stop only verifies and signals an existing process. It can run on an older
# Node.js than the CLI and supervisor it controls.
minimum_node=22.12.0
if [ "$runtime_action" = stop ]; then minimum_node=18.0.0; fi
if ! node_error=$(
  "$remote_node" --input-type=commonjs -e '
    const { realpathSync, writeSync } = require("node:fs");
    const [minimum, nodePath] = process.argv.slice(1);
    const version = process.versions.node;
    const [major, minor, patch] = version.split(".").map(Number);
    const [minMajor, minMinor, minPatch] = minimum.split(".").map(Number);
    let error;
    if (process.platform !== "linux") {
      error = "The remote Harness Host requires Linux.";
    } else if (!/^\d+\.\d+\.\d+$/.test(version) || (major - minMajor || minor - minMinor || patch - minPatch) < 0) {
      error = `The SSH login terminal selects Node.js v${version} (${nodePath}). This operation requires Node.js >=${minimum}.`;
    } else if (realpathSync(nodePath) !== realpathSync(process.execPath)) {
      error = `Node.js in the SSH login terminal must resolve directly to its executable (${nodePath}).`;
    }
    if (error) {
      writeSync(3, JSON.stringify({ code: "REMOTE_NODE_REQUIRED", error }));
      process.exitCode = 1;
    }
  ' "$minimum_node" "$remote_node" </dev/null 3>&1 >/dev/null 2>&1
); then
  [ -n "$node_error" ] ||
    fail_login_node 'Could not execute the Node.js selected by the SSH login terminal.' REMOTE_NODE_REQUIRED
  printf 'DSH_REMOTE_SSH_RESULT %s\n' "$node_error"
  exit 0
fi
