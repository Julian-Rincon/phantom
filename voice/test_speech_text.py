from speech_text import normalize_for_speech as n

def test_terms_and_acronyms():
    assert n("Revisé el pipeline de la API", "es") == "Revisé el páiplain de la a pe i"
    assert n("Tu Pull Request en GitHub", "es") == "Tu pul ríquest en guít jab"

def test_whole_words_only():
    assert n("la rapidez de mergear y apilar", "es") == "la rapidez de mergear y apilar"
    assert n("api en minúscula no es sigla", "es") == "api en minúscula no es sigla"

def test_name_and_english_untouched():
    assert n("Buenos días, Julian", "es") == "Buenos días, Julián"
    assert n("Check the pipeline", "en") == "Check the pipeline"


def test_versiones_y_terminos_nuevos():
    from speech_text import normalize_for_speech
    t = normalize_for_speech("Python 3.14, Codeg 0.47.0, 2.100 pesos, README, AWS y la IA", "es")
    assert "páizon tres punto catorce" in t and "cero punto cuarenta y siete punto cero" in t
    assert "dos mil cien pesos" in t
    assert "rídmi" in t and "a doble u ese" in t and "i a" in t


def test_quita_emojis():
    from speech_text import normalize_for_speech
    assert normalize_for_speech("Listo ✅ 🚀 mira 👉 esto", "es") == "Listo mira esto"
    assert normalize_for_speech("Done ✅", "en") == "Done "


def test_numeros_en_palabras():
    from speech_text import normalize_for_speech, numero_a_palabras as w
    assert [w(n) for n in (21, 100, 101, 1000, 2100, 21000, 31000, 1000000, 2500000)] == [
        "veintiuno", "cien", "ciento uno", "mil", "dos mil cien", "veintiún mil", "treinta y un mil",
        "un millón", "dos millones quinientos mil"]
    t = normalize_for_speech("2.100 pesos el 22/11/2026 a las 15:30, 35% de 1.785, 88,5 y 9:00", "es")
    assert t == ("dos mil cien pesos el veintidós de noviembre de dos mil veintiséis a las quince y treinta, "
                 "treinta y cinco por ciento de mil setecientos ochenta y cinco, ochenta y ocho coma cinco "
                 "y nueve en punto")
    assert normalize_for_speech("versión 0.47.0", "es") == "versión cero punto cuarenta y siete punto cero"
