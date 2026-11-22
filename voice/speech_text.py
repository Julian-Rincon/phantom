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
    "python": "páizon", "readme": "rídmi", "multi-query": "multi cuéri", "multiquery": "multi cuéri",
    "linkedin": "línkedin", "whatsapp": "guatsap", "gmail": "yi meil", "openai": "open ei ai",
    "key": "llave", "gemma": "yema",
}
ACRONYMS = {
    "PLN": "pe ele ene", "API": "a pe i", "GPU": "ge pe u", "CPU": "ce pe u",
    "VM": "ve eme", "URL": "u erre ele", "PDF": "pe de efe", "MCP": "eme ce pe",
    "RAM": "ram", "SSH": "ese ese ache", "QA": "cu a", "AWS": "a doble u ese", "GCP": "ge ce pe",
    "IA": "i a", "AI": "ei ai", "CLI": "ce ele i", "CI": "ce i", "EC2": "e ce dos",
    "F1": "Fórmula 1", "GP": "Gran Premio", "LATAM": "Latinoamérica", "ATLAS": "Atlas",
    "LEDGER": "Léyer", "FORGE": "Forch", "NEXUS": "Nexus", "DELOAD": "de descarga",
}
NAMES = {"Julian": "Julián"}

_term_re = re.compile(r"\b(" + "|".join(sorted(map(re.escape, TERMS), key=len, reverse=True)) + r")\b", re.I)
_acr_re = re.compile(r"\b(" + "|".join(map(re.escape, ACRONYMS)) + r")\b")
_version_re = re.compile(r"\b\d+\.\d{1,2}(?:\.\d+)?\b(?!\.\d)")  # 3.14, 0.47.0; no 2.100 (miles)
_name_re = re.compile(r"\b(" + "|".join(map(re.escape, NAMES)) + r")\b")


# Emojis y pictogramas: el modelo no los sabe leer y suelen salir como ruido.
_emoji_re = re.compile("[\U0001F000-\U0001FAFF\u2600-\u27BF\u2B00-\u2BFF\uFE0F\u200D]+")


_UNI = ("cero uno dos tres cuatro cinco seis siete ocho nueve diez once doce trece catorce quince "
        "dieciséis diecisiete dieciocho diecinueve veinte veintiuno veintidós veintitrés veinticuatro "
        "veinticinco veintiséis veintisiete veintiocho veintinueve").split()
_DEC = "_ _ _ treinta cuarenta cincuenta sesenta setenta ochenta noventa".split()
_CEN = ("_ ciento doscientos trescientos cuatrocientos quinientos seiscientos setecientos "
        "ochocientos novecientos").split()
_MESES = ("enero febrero marzo abril mayo junio julio agosto septiembre octubre noviembre "
          "diciembre").split()


def _apocope(palabras: str) -> str:
    """'veintiuno mil' → 'veintiún mil', 'treinta y uno mil' → 'treinta y un mil'."""
    if palabras.endswith("veintiuno"):
        return palabras[:-3] + "ún"
    return palabras[:-1] if palabras.endswith("uno") else palabras


def numero_a_palabras(n: int) -> str:
    """Entero en palabras (español), hasta 999 999 999 999; más grande se deja en cifras."""
    if n < 30:
        return _UNI[n]
    if n < 100:
        d, u = divmod(n, 10)
        return _DEC[d] + (f" y {_UNI[u]}" if u else "")
    if n < 1000:
        c, r = divmod(n, 100)
        if n == 100:
            return "cien"
        return _CEN[c] + (f" {numero_a_palabras(r)}" if r else "")
    if n < 1_000_000:
        m, r = divmod(n, 1000)
        miles = "mil" if m == 1 else f"{_apocope(numero_a_palabras(m))} mil"
        return miles + (f" {numero_a_palabras(r)}" if r else "")
    if n < 10**12:
        m, r = divmod(n, 1_000_000)
        mill = "un millón" if m == 1 else f"{_apocope(numero_a_palabras(m))} millones"
        return mill + (f" {numero_a_palabras(r)}" if r else "")
    return str(n)


def _hablar_numeros(text: str) -> str:
    """Fechas, horas, porcentajes, miles y decimales a palabras: Chatterbox lee mal las cifras
    ("2.100" → "2,000 dólares", "22/11/2026" → ruido)."""
    def fecha(m: re.Match) -> str:
        d, mes = int(m.group(1)), int(m.group(2))
        if not (1 <= mes <= 12 and 1 <= d <= 31):
            return m.group(0)
        anio = f" de {m.group(3)}" if m.group(3) else ""
        return f"{d} de {_MESES[mes - 1]}{anio}"
    text = re.sub(r"\b(\d{1,2})/(\d{1,2})(?:/(\d{4}))?\b", fecha, text)
    text = re.sub(r"\b(\d{1,2}):(\d{2})\b",
                  lambda m: f"{int(m.group(1))} en punto" if m.group(2) == "00" else f"{int(m.group(1))} y {int(m.group(2))}",
                  text)
    text = re.sub(r"\b(\d{1,3}(?:\.\d{3})+)\b(?![.,]\d)", lambda m: m.group(1).replace(".", ""), text)  # 2.100 → 2100
    text = re.sub(r"\b(\d+),(\d+)\b", r"\1 coma \2", text)  # 88,5
    text = re.sub(r"(\d)\s?%", r"\1 por ciento", text)
    text = re.sub(r"\$\s?(\d)", r"\1", text)
    return re.sub(r"\b\d+\b", lambda m: numero_a_palabras(int(m.group(0))) if len(m.group(0)) <= 12 else m.group(0), text)


def normalize_for_speech(text: str, lang: str) -> str:
    text = re.sub(r"[ \t]{2,}", " ", _emoji_re.sub("", text))
    if lang != "es":
        return text
    text = _name_re.sub(lambda m: NAMES[m.group(1)], text)
    text = _version_re.sub(lambda m: " punto ".join(m.group(0).split(".")), text)  # 3.14 → 3 punto 14
    text = _hablar_numeros(text)
    text = _acr_re.sub(lambda m: ACRONYMS[m.group(1)], text)
    return _term_re.sub(lambda m: TERMS[m.group(1).lower()], text)
