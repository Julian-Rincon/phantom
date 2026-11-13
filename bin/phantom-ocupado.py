#!/usr/bin/python3 -I
"""Dice si algún agente de Phantom está trabajando (antes de reiniciarlo).

Sale 0 si todo está quieto y 1 si no, e imprime el motivo. Mira los procesos de
Claude Code que cuelgan de phantom-desktop.service: hijos que no sean servidores
MCP (herramientas o tareas en marcha), escritura reciente en su transcripción, o
un turno sin cerrar.
"""
import glob
import json
import os
import subprocess
import sys
import time

QUIET = 300  # segundos sin escribir en la transcripción
IGNORA = ("mcp serve", "mcp-serve", "nexus-mcp", "codeg-mcp", "unity mcp", "/unity",
          "hermes-agent", "hermes mcp", "ollama", "llama-server", "tail -n +1 -f", "tail -f",
          "voicestudio-mcp", "mcp_shim")


def salida(*cmd):
    return subprocess.run(cmd, capture_output=True, text=True).stdout


main = salida("systemctl", "--user", "show", "-p", "MainPID", "--value", "phantom-desktop").strip()
hijos = {}
for linea in salida("ps", "-eo", "pid=,ppid=,args=").splitlines():
    p = linea.split(None, 2)
    if len(p) == 3:
        hijos.setdefault(p[1], []).append(p)


def descendientes(pid):
    out = []
    for h in hijos.get(pid, []):
        out.append(h)
        out += descendientes(h[0])
    return out


ocupado = []
agentes = [d for d in descendientes(main) if "agent-sdk-linux-x64/claude" in d[2]]
for pid, _, args in agentes:
    sid = next((a.split("=", 1)[1] for a in args.split() if a.startswith("--resume=")), None)
    extra = [d[2][:70] for d in descendientes(pid) if not any(m in d[2] for m in IGNORA)]
    if extra:
        ocupado.append(f"{pid} hijos: {extra[:2]}")
    if not sid:
        continue
    fs = glob.glob(os.path.expanduser(f"~/.claude/projects/*/{sid}.jsonl"))
    if not fs:
        continue
    edad = time.time() - os.path.getmtime(fs[0])
    if edad < QUIET:
        ocupado.append(f"{sid[:8]} escribió hace {int(edad)}s")
    ultimo = None
    for linea in reversed(open(fs[0], errors="replace").readlines()[-200:]):
        try:
            d = json.loads(linea)
        except ValueError:
            continue
        t = d.get("type")
        if t == "system" and d.get("subtype") in ("stop_hook_summary", "turn_duration"):
            ultimo = "fin"
            break
        if t == "assistant":
            ultimo = "fin" if d["message"].get("stop_reason") == "end_turn" else "en turno"
            break
        if t == "user":
            # Un Esc deja "[Request interrupted by user]" como último mensaje: el turno ya terminó.
            c = d.get("message", {}).get("content")
            txt = c if isinstance(c, str) else " ".join(x.get("text", "") for x in c or [] if isinstance(x, dict))
            ultimo = "fin" if txt.startswith("[Request interrupted by user") else "en turno"
            break
    if ultimo == "en turno":
        ocupado.append(f"{sid[:8]} en turno")

print("; ".join(ocupado) or f"inactivo ({len(agentes)} agentes conectados)")
sys.exit(1 if ocupado else 0)
