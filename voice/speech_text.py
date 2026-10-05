"""Normaliza texto en español antes de sintetizarlo: términos técnicos en inglés escritos
como suenan, siglas deletreadas y nombres con su acento. Las claves se buscan como palabra
completa: los términos sin distinguir mayúsculas, las siglas solo en MAYÚSCULAS."""
from __future__ import annotations
import re

TERMS = {
    "pipeline": "páiplain", "pull request": "pul ríquest", "github": "guít jab",
    "commit": "cómit", "commits": "cómits", "deploy": "diplói", "backend": "bákend",
    "frontend": "frónend", "email": "ímeil", "phantom": "fántom", "opencode": "óupen coud",
    "claude": "clod", "docker": "dóker", "script": "escrípt", "branch": "bránch",
    "merge": "merch", "worktree": "uórk tri", "bug": "bag", "debug": "dibág",
    "online": "onláin", "update": "ápdeit", "framework": "fréimuork", "dashboard": "dáshbord",
    "feedback": "fídbak", "workflow": "uórkflou", "prompt": "prómpt", "token": "tóken",
}
ACRONYMS = {
    "PLN": "pe ele ene", "API": "a pe i", "GPU": "ge pe u", "CPU": "ce pe u",
    "VM": "ve eme", "URL": "u erre ele", "PDF": "pe de efe", "MCP": "eme ce pe",
    "RAM": "ram", "SSH": "ese ese ache", "QA": "cu a",
}
NAMES = {"Julian": "Julián"}

_term_re = re.compile(r"\b(" + "|".join(sorted(map(re.escape, TERMS), key=len, reverse=True)) + r")\b", re.I)
_acr_re = re.compile(r"\b(" + "|".join(map(re.escape, ACRONYMS)) + r")\b")
_name_re = re.compile(r"\b(" + "|".join(map(re.escape, NAMES)) + r")\b")


def normalize_for_speech(text: str, lang: str) -> str:
    if lang != "es":
        return text
    text = _name_re.sub(lambda m: NAMES[m.group(1)], text)
    text = _acr_re.sub(lambda m: ACRONYMS[m.group(1)], text)
    return _term_re.sub(lambda m: TERMS[m.group(1).lower()], text)
