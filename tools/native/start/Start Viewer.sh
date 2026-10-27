#!/bin/sh
# Resolve the package location, never the caller's working directory.
cd -- "$(dirname -- "$0")" || exit 1

# The executable provides its own desktop window. --console is retained for
# existing terminal callers and never spawns another terminal.
if [ "${1-}" = '--console' ]; then
    shift
    set -- --headless "$@"
fi
viewer_headless=false
for argument in "$@"; do
    case "$argument" in --headless|--no-browser) viewer_headless=true ;; esac
done

fail() {
    printf '%s\n' "$1" 'Extract the complete package, then try again.' '请完整解压软件包后重试。'
    if ! [ -t 0 ] && [ "$viewer_headless" = false ]; then
        if command -v zenity >/dev/null 2>&1; then zenity --error --text="$1" 2>/dev/null || true
        elif command -v osascript >/dev/null 2>&1; then osascript -e 'display alert "Robot Data Viewer: package is incomplete. Extract the complete ZIP. / 请完整解压 ZIP。"' 2>/dev/null || true
        fi
    fi
    if [ -t 0 ]; then
        printf '%s\n' 'Press Enter to close / 按回车关闭'
        read -r unused
    fi
    exit 1
}

[ -f ./RobotDataViewer ] && [ -d ./_internal ] && [ -f ./viewer.html ] && [ -f ./force-runtime.js ] && [ -f ./model/model.json ] && [ -f ./model/force.onnx ] || fail 'The package is incomplete / 软件包不完整。'
[ -x ./RobotDataViewer ] || chmod u+x ./RobotDataViewer || fail 'Cannot run the launcher / 无法运行启动器。'
exec ./RobotDataViewer "$@"
