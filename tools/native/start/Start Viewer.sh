#!/bin/sh
# Resolve the package location, never the caller's working directory.
cd -- "$(dirname -- "$0")" || exit 1

# File managers may launch scripts without a terminal. Show a window so the
# local URL, startup errors and Ctrl+C shutdown remain available.
if [ "${1-}" = '--console' ]; then
    shift
elif [ "$#" -eq 0 ] && ! [ -t 0 ]; then
    for terminal in x-terminal-emulator gnome-terminal konsole xterm; do
        if command -v "$terminal" >/dev/null 2>&1; then
            if [ "$terminal" = 'gnome-terminal' ]; then
                exec "$terminal" -- /bin/sh "$PWD/$(basename -- "$0")" --console
            fi
            exec "$terminal" -e /bin/sh "$PWD/$(basename -- "$0")" --console
        fi
    done
fi

fail() {
    printf '%s\n' "$1" 'Extract the complete package, then try again.' '请完整解压软件包后重试。'
    if [ -t 0 ]; then
        printf '%s\n' 'Press Enter to close / 按回车关闭'
        read -r unused
    fi
    exit 1
}

[ -f ./RobotDataViewer ] && [ -d ./_internal ] && [ -f ./viewer.html ] && [ -f ./force-runtime.js ] && [ -f ./model/model.json ] && [ -f ./model/force.onnx ] || fail 'The package is incomplete / 软件包不完整。'
[ -x ./RobotDataViewer ] || chmod u+x ./RobotDataViewer || fail 'Cannot run the launcher / 无法运行启动器。'
exec ./RobotDataViewer "$@"
