#!/usr/bin/env python3
"""
Build Ikemen AI Patcher as a Windows x64 portable exe.

This script expects to be run from the AI_Patcher folder, or from anywhere after
pointing to this file. It validates the offline QR asset, runs the configured
Electron Builder command, and checks the generated artifact.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path


APP_DIR = Path(__file__).resolve().parent
DIST_DIR = APP_DIR / "dist"
PACKAGE_JSON = APP_DIR / "package.json"
QR_ASSET = APP_DIR / "public" / "assets" / "paypal-huytoken.jpg"
QR_URL = "https://i.ibb.co/PGSn4TVM/Paypal-huytoken.jpg"


def fail(message: str) -> None:
    print(f"[ERROR] {message}", file=sys.stderr)
    raise SystemExit(1)


def run(command: list[str], *, timeout: int | None = None) -> None:
    print(f"[RUN] {' '.join(command)}")
    completed = subprocess.run(command, cwd=APP_DIR, timeout=timeout)
    if completed.returncode != 0:
        fail(f"Command failed with exit code {completed.returncode}: {' '.join(command)}")


def load_package() -> dict:
    if not PACKAGE_JSON.exists():
        fail(f"Missing package.json: {PACKAGE_JSON}")
    return json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))


def command_path(name: str) -> str:
    candidates = [name]
    if os.name == "nt" and not name.lower().endswith((".exe", ".cmd", ".bat")):
        candidates = [f"{name}.cmd", f"{name}.exe", name]
    for candidate in candidates:
        resolved = shutil.which(candidate)
        if resolved:
            return resolved
    fail(f"Missing command on PATH: {name}")


def require_command(name: str) -> str:
    resolved = command_path(name)
    if resolved is None:
        fail(f"Missing command on PATH: {name}")
    return resolved


def ensure_node_modules(skip_install: bool, npm_cmd: str) -> None:
    if (APP_DIR / "node_modules").exists():
        return
    if skip_install:
        fail("node_modules is missing. Run npm install first, or omit --skip-install.")
    if not (APP_DIR / "package-lock.json").exists():
        fail("node_modules and package-lock.json are missing. Run npm install manually.")
    run([npm_cmd, "ci"], timeout=300)


def ensure_qr_asset(download: bool) -> None:
    if QR_ASSET.exists() and QR_ASSET.stat().st_size > 0:
        print(f"[OK] Offline QR asset: {QR_ASSET}")
        return
    if not download:
        fail(f"Missing offline QR asset: {QR_ASSET}")

    print(f"[GET] {QR_URL}")
    QR_ASSET.parent.mkdir(parents=True, exist_ok=True)
    try:
        urllib.request.urlretrieve(QR_URL, QR_ASSET)
    except Exception as exc:
        fail(f"Cannot download QR asset. Save it manually to {QR_ASSET}. Details: {exc}")

    if not QR_ASSET.exists() or QR_ASSET.stat().st_size <= 0:
        fail(f"Downloaded QR asset is empty: {QR_ASSET}")
    print(f"[OK] Downloaded QR asset: {QR_ASSET}")


def expected_artifact(package_data: dict) -> Path:
    product_name = package_data.get("build", {}).get("productName") or package_data.get("name")
    version = package_data.get("version")
    if not product_name or not version:
        fail("package.json must contain build.productName and version.")
    return DIST_DIR / f"{product_name}-{version}-x64.exe"


def verify_packaged_files() -> None:
    packaged_qr = DIST_DIR / "win-unpacked" / "resources" / "app" / "public" / "assets" / "paypal-huytoken.jpg"
    packaged_helper = DIST_DIR / "win-unpacked" / "resources" / "app" / "helper" / "server.js"
    for path in (packaged_qr, packaged_helper):
        if not path.exists():
            fail(f"Packaged file missing: {path}")
    print(f"[OK] Packaged QR asset: {packaged_qr}")
    print(f"[OK] Packaged helper: {packaged_helper}")


def build(timeout: int, skip_install: bool, download_qr: bool) -> Path:
    if os.name != "nt":
        fail("This build script is intended for Windows x64 packaging.")

    require_command("node")
    npm_cmd = require_command("npm")
    package_data = load_package()
    ensure_node_modules(skip_install, npm_cmd)
    ensure_qr_asset(download_qr)

    artifact = expected_artifact(package_data)
    before_mtime = artifact.stat().st_mtime if artifact.exists() else 0

    run([npm_cmd, "run", "dist:win"], timeout=timeout)

    if not artifact.exists():
        fail(f"Expected artifact was not created: {artifact}")
    if artifact.stat().st_mtime <= before_mtime:
        fail(f"Artifact timestamp did not update: {artifact}")

    verify_packaged_files()
    print(f"[OK] Built exe: {artifact}")
    print(f"[OK] Size: {artifact.stat().st_size:,} bytes")
    print(f"[OK] Updated: {time.ctime(artifact.stat().st_mtime)}")
    return artifact


def main() -> None:
    parser = argparse.ArgumentParser(description="Build Ikemen AI Patcher portable Windows x64 exe.")
    parser.add_argument("--timeout", type=int, default=300, help="Build timeout in seconds. Default: 300.")
    parser.add_argument("--skip-install", action="store_true", help="Do not run npm ci if node_modules is missing.")
    parser.add_argument(
        "--download-qr",
        action="store_true",
        help="Download the PayPal QR asset if the local offline copy is missing.",
    )
    args = parser.parse_args()
    build(args.timeout, args.skip_install, args.download_qr)


if __name__ == "__main__":
    main()
