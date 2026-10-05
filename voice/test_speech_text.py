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
