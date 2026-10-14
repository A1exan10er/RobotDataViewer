@echo off
setlocal
chcp 65001 >nul
pushd "%~dp0" || goto incomplete
if not exist "RobotDataViewer.exe" goto incomplete
if not exist "_internal\" goto incomplete
if not exist "viewer.html" goto incomplete
if not exist "force-runtime.js" goto incomplete
if not exist "model\model.json" goto incomplete
if not exist "model\force.onnx" goto incomplete
"%CD%\RobotDataViewer.exe" %*
set "viewer_exit=%ERRORLEVEL%"
popd
if not "%viewer_exit%"=="0" (
  echo The viewer could not start. Keep the complete package together and check the message above.
  echo 启动失败。请保留完整软件包，并查看上方错误信息。
  pause
)
exit /b %viewer_exit%
:incomplete
echo The package is incomplete. Extract the entire ZIP before starting the viewer.
echo 软件包不完整。请先完整解压 ZIP，再启动查看器。
pause
exit /b 1
