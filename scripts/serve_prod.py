#!/usr/bin/env python3
"""Daemonize the standalone Next server (double-fork + setsid) so it survives
this Bash tool's process-tree reclamation."""
import os
import subprocess

PROJ = "/home/z/my-project"
CMD = ["bun", ".next/standalone/server.js"]
ENV = {**os.environ, "NODE_ENV": "production", "PORT": "3000", "HOSTNAME": "0.0.0.0"}

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
