#!/usr/bin/env python3
"""Daemonize the standalone Next server (double-fork + setsid) so it survives
this Bash tool's process-tree reclamation.

Also performs the two copies the standalone build does NOT do itself:
  .next/static  -> .next/standalone/.next/static   (JS chunks / CSS)
  public        -> .next/standalone/public         (brand assets, icons)
Without these, the server serves HTML but every chunk 404s and the page
never hydrates — a dead static shell.
"""
import os
import shutil
import subprocess
import time

PROJ = "/home/z/my-project"
STATIC_SRC = os.path.join(PROJ, ".next/static")
STATIC_DST = os.path.join(PROJ, ".next/standalone/.next/static")
PUBLIC_SRC = os.path.join(PROJ, "public")
PUBLIC_DST = os.path.join(PROJ, ".next/standalone/public")
CMD = ["bun", ".next/standalone/server.js"]
ENV = {**os.environ, "NODE_ENV": "production", "PORT": "3000", "HOSTNAME": "0.0.0.0"}


def sync_static():
    for src, dst in ((STATIC_SRC, STATIC_DST), (PUBLIC_SRC, PUBLIC_DST)):
        if not os.path.isdir(src):
            continue
        if os.path.isdir(dst):
            shutil.rmtree(dst)
        shutil.copytree(src, dst)
        print(f"synced {src} -> {dst}")


def kill_stale():
    """Kill any server already holding :3000 (a previous build's daemon)."""
    try:
        out = subprocess.run(["pgrep", "-f", "standalone/server.js"], capture_output=True, text=True).stdout
        for pid in [int(p) for p in out.split() if p.strip()]:
            if pid != os.getpid():
                os.kill(pid, 15)
                print(f"killed stale server pid {pid}")
    except Exception as e:
        print(f"pgrep/kill: {e}")
    time.sleep(1.5)


if __name__ == "__main__":
    kill_stale()
    sync_static()

    log = open(os.path.join(PROJ, "server.log"), "ab", buffering=0)

    pid = os.fork()
    if pid == 0:
        os.setsid()
        pid2 = os.fork()
        if pid2 == 0:
            os.chdir(PROJ)
            os.dup2(log.fileno(), 1)
            os.dup2(log.fileno(), 2)
            subprocess.run(CMD, env=ENV, cwd=PROJ)
            os._exit(0)
        os._exit(0)
    os.waitpid(pid, 0)
    print("daemon started")
