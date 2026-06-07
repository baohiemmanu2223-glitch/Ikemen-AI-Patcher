import os
import shutil
import subprocess
import time
import urllib.request
import webbrowser


ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
HELPER_DIR = os.path.join(ROOT_DIR, "helper")
SERVER_JS = os.path.join(HELPER_DIR, "server.js")
HOST = "127.0.0.1"
PORT = int(os.environ.get("PORT", "8787"))
URL = f"http://{HOST}:{PORT}"


def run_powershell(command):
    return subprocess.run(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
        cwd=ROOT_DIR,
        text=True,
        capture_output=True,
    )


def stop_existing_helper():
    root_path = ROOT_DIR.replace("\\", "\\\\")
    server_path = SERVER_JS.replace("\\", "\\\\")
    command = rf"""
    $port = {PORT}
    $root = '{root_path}'
    $server = '{server_path}'
    $ids = @()

    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
      ForEach-Object {{ $ids += $_.OwningProcess }}

    Get-CimInstance Win32_Process |
      Where-Object {{
        $_.Name -match '^node(\.exe)?$' -and
        $_.CommandLine -and
        $_.CommandLine -match 'server\.js' -and
        (
          $_.CommandLine.Replace('/', '\') -like "*$server*" -or
          $_.CommandLine.Replace('/', '\') -like "*$root*"
        )
      }} |
      ForEach-Object {{ $ids += $_.ProcessId }}

    $ids |
      Where-Object {{ $_ }} |
      Sort-Object -Unique |
      ForEach-Object {{
        Write-Output "Stopping helper PID $_"
        Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
      }}
    """
    result = run_powershell(command)
    if result.stdout.strip():
        print(result.stdout.strip())
    if result.stderr.strip():
        print(result.stderr.strip())


def wait_until_ready(timeout=12):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"{URL}/api/health", timeout=1.2) as response:
                if response.status == 200:
                    return True
        except Exception:
            time.sleep(0.35)
    return False


def start_helper():
    if not shutil.which("node"):
        raise RuntimeError("Node.js was not found in PATH.")

    env = os.environ.copy()
    env["PORT"] = str(PORT)
    return subprocess.Popen(
        ["node", "server.js"],
        cwd=HELPER_DIR,
        env=env,
        creationflags=subprocess.CREATE_NEW_CONSOLE,
    )


def main():
    print("Ikemen AI Patcher Helper Reset")
    print(f"Project: {ROOT_DIR}")
    print(f"Helper:  {SERVER_JS}")
    print(f"URL:     {URL}")
    print()

    if not os.path.exists(SERVER_JS):
        print(f"ERROR: server.js not found: {SERVER_JS}")
        input("Press Enter to close...")
        return 1

    print("Stopping old helper process...")
    stop_existing_helper()

    print("Starting helper...")
    try:
        process = start_helper()
    except Exception as exc:
        print(f"ERROR: {exc}")
        input("Press Enter to close...")
        return 1

    print(f"Started helper PID {process.pid}")

    if wait_until_ready():
        print(f"Helper is ready: {URL}")
        webbrowser.open(URL)
    else:
        print("Helper started, but /api/health did not respond before timeout.")
        print("Check the new Node console window for errors.")

    print()
    print("Done. This window will close in 8 seconds.")
    time.sleep(8)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
