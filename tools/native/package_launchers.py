"""Package portable entry points with no build-machine paths or external runtime."""
from pathlib import Path
import shutil

START = Path(__file__).resolve().parent / 'start'
ENTRY_POINTS = {'windows': 'Start Viewer.cmd', 'linux': 'Start Viewer.sh', 'macos': 'Start Viewer.command'}


def write_launchers(output, system, version):
    output = Path(output)
    files = {'windows': [('Start Viewer.cmd', 'Start Viewer.cmd')],
             'linux': [('Start Viewer.sh', 'Start Viewer.sh')],
             'macos': [('Start Viewer.sh', 'Start Viewer.command')]}
    for source, target in files[system]:
        path = output / target
        if system == 'windows':
            path.write_bytes((START / source).read_text(encoding='utf-8').replace('\n', '\r\n').encode('utf-8'))
        else:
            shutil.copyfile(START / source, path)
            path.chmod(0o755)
    entry = ENTRY_POINTS[system]
    instructions = f'''Robot Data Viewer {version} — {system} portable / 便携版

1. Extract the entire ZIP to a folder on this computer.
2. Open {entry} (Linux: right-click > Run as a Program).
   Your default browser opens automatically.
3. Keep the launcher window open. Press Ctrl+C in that window to stop it.
4. Choose Recordings to open your data, or Live cameras > Start all for USB cameras.
   Allow browser camera access, assign each camera's role, and name it as needed.

No installation, Python, Node.js, command-line setup or internet is required.
Keep ALL files and subfolders together. You can move or rename the whole folder.
Do not run from inside the ZIP or copy only the Start Viewer file.
If the browser does not open, copy the local URL shown in the launcher window.
Choose a desktop Chrome, Edge or Firefox browser. The service runs only on this PC.
Close the viewer tab when finished to release cameras, then close the launcher.
See QUICKSTART_EN.md and LIVE_CAMERAS.md for camera settings and calibration.

1. 将整个 ZIP 完整解压到本机文件夹。
2. 打开 {entry}（Linux：右击并选择“作为程序运行”），默认浏览器将自动打开。
3. 使用期间保持启动窗口开启；在该窗口按 Ctrl+C 可停止服务。
4. 选择“录制数据”打开数据，或选择“实时相机 > 全部启动”检查 USB 相机。
   允许浏览器使用相机，再为每台相机指定用途并命名。

无需安装、Python、Node.js、命令行配置或网络。请保留所有文件和子目录。
可以整体移动或重命名文件夹；不要在 ZIP 内启动，也不要只复制启动文件。
浏览器未自动打开时，请复制启动窗口显示的本机网址。
建议使用桌面版 Chrome、Edge 或 Firefox；服务仅在本机运行。
结束后请关闭查看器标签页释放相机，再关闭启动窗口。
详细操作见 QUICKSTART_ZH.md 和 LIVE_CAMERAS.md。
'''
    if system == 'linux':
        instructions += '''
Linux desktop environments differ. If double-click opens a text editor,
right-click Start Viewer.sh > Run as a
Program (enable Properties > Permissions > Allow executing file as program if
needed). You can also open the bundled RobotDataViewer executable directly.
Linux 桌面的启动行为可能不同。如果双击打开了文本编辑器，请右击
Start Viewer.sh，选择“作为程序运行”；必要时在属性/权限中允许作为程序执行。
也可以直接打开包内的 RobotDataViewer 可执行文件。
'''
    (output / 'START_HERE.txt').write_text(instructions, encoding='utf-8')
