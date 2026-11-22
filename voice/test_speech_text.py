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
    assert "páizon 3 punto 14" in t and "0 punto 47 punto 0" in t and "2.100 pesos" in t
    assert "rídmi" in t and "a doble u ese" in t and "i a" in t
