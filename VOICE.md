# phantom-voice — servicio de voz local

## Qué es

`phantom-voice` es un servicio HTTP local que le da a Phantom voz de
entrada (STT, reconocimiento de voz) y de salida (TTS, síntesis de voz).
Todo el procesamiento — decodificación de audio, inferencia del modelo de
transcripción y generación de audio — ocurre en esta máquina. Ningún byte
de audio ni de texto sale a un servicio en la nube: no hay llamadas a APIs
externas de voz.

## Privacidad y superficie de red

- El proceso escucha **solo en `127.0.0.1:3091`** (puerto configurable con
  `PHANTOM_VOICE_PORT`). No hay bind a `0.0.0.0` ni a la IP de la LAN;
  `ss -ltnp` solo debe mostrar `127.0.0.1:3091`.
- CORS está restringido a los orígenes de la propia UI de Phantom
  (`http://127.0.0.1:3080` y `http://localhost:3080`), métodos
  `GET/POST/OPTIONS`, cabeceras `Authorization` y `Content-Type`.
- Toda petición a `/stt` o `/tts` requiere `Authorization: Bearer
  <CODEG_TOKEN>`, el mismo token que usa `codeg.service`, leído una vez al
  arrancar desde `~/.config/codeg/server.env`. `GET /health` y `OPTIONS` son
  las únicas excepciones.
- Los modelos (faster-whisper para STT, kokoro-onnx para TTS) corren
  localmente; el de STT usa la GPU si está disponible y cae a CPU si no.

## Modelos y motores

| | Motor | Modelo | Dispositivo |
|---|---|---|---|
| STT | faster-whisper (ctranslate2) | `large-v3-turbo`, float16 | CUDA (RTX 4060), fallback automático a CPU int8 si falla la inicialización de CUDA |
| TTS | kokoro-onnx | `kokoro-v1.0.onnx` (reutilizado de `~/.local/share/brag/models/`, no duplicado) | CPU (onnxruntime) |

Voces por defecto: `ef_dora` para español, `af_heart` para inglés
(overridable por petición con el campo `voice`).

Medido en esta máquina (RTX 4060 Laptop 8 GB, driver 615.71):

- **STT**: clip de ~3.3 s en español, en caliente, ≈ 305–325 ms de
  procesamiento (`elapsed_ms`) — dentro del objetivo de < 1 s por cada 5 s
  de audio. Primer request (incluye carga/descarga del modelo): ~35 s, una
  sola vez por arranque del servicio.
- **VRAM**: `large-v3-turbo` en float16 usa ≈ 2.2 GB de los 8 GB
  disponibles (confirmado con `nvidia-smi`: 210 MiB en reposo → 2407 MiB
  con el modelo cargado). Como este equipo también se usa para jugar, el
  modelo **se descarga solo tras estar inactivo** — ver la sección
  siguiente — en vez de quedar fijo en VRAM todo el tiempo que el servicio
  esté arriba.
- **RAM de kokoro (TTS)**: ≈ 450–490 MB de RAM del sistema (proceso CPU,
  `onnxruntime`), 0 VRAM. No es significativo frente a la RAM total del
  equipo ni compite con la GPU, así que no se implementó descarga por
  inactividad para TTS — solo para STT, que es el que ocupa VRAM.
- **TTS**: una frase de ~13 palabras en español tarda ≈ 750–950 ms en
  caliente (CPU, onnxruntime). Esto **no** alcanza el objetivo de
  < 400 ms. Se evaluó `onnxruntime-gpu`, pero la build actual (1.30)
  requiere CUDA 13 + las librerías `libcublas.so.13` correspondientes, que
  no están disponibles en este equipo (solo hay runtime CUDA 12 vía pip);
  con eso instalado el proveedor CUDA falla al cargar y cae en silencio a
  CPU con el mismo tiempo. Queda como decisión pendiente para el lead: (a)
  aceptar la latencia de CPU tal cual, (b) instalar el toolkit CUDA 13 del
  sistema para desbloquear `onnxruntime-gpu`, o (c) evaluar un motor TTS
  más liviano.

## Descarga por inactividad del modelo de STT (VRAM)

El modelo de STT (`large-v3-turbo`, ≈ 2.2 GB en VRAM) se carga de forma
perezosa en la primera petición a `/stt` y, si pasan
`PHANTOM_VOICE_IDLE_UNLOAD_S` segundos (600 por defecto, 10 minutos) sin
otra petición, se libera automáticamente: se sueltan las referencias al
objeto `WhisperModel`, se llama a `gc.collect()` y ctranslate2 (el backend
de faster-whisper, no usa el allocator cacheado de torch) libera la VRAM
desde su propio destructor. La siguiente petición a `/stt` vuelve a
cargarlo de forma perezosa, con el mismo costo de arranque que la primera
vez que arrancó el servicio.

- `PHANTOM_VOICE_IDLE_UNLOAD_S=0` desactiva la descarga por inactividad.
- Un `asyncio.Lock` protege la carga y la descarga, así que una petición a
  `/stt` que empieza justo cuando el chequeo de inactividad decide
  descargar nunca ve un modelo a medio destruir: o encuentra el modelo ya
  cargado, o dispara una recarga perezosa limpia.
- `GET /health` expone `stt.loaded` (`true`/`false`) para saber en
  cualquier momento si el modelo está actualmente en VRAM.

Verificado en vivo con `PHANTOM_VOICE_IDLE_UNLOAD_S=20` (vía un drop-in
temporal de systemd, luego removido — el valor en el repo sigue siendo el
default de 600s):

| Momento | VRAM (`nvidia-smi`) | `stt.loaded` |
|---|---|---|
| En reposo, antes de cualquier `/stt` | 210 MiB | `false` |
| Justo después de una petición a `/stt` | 2407 MiB | `true` |
| 22 s después de esa petición (umbral: 20 s) | 317 MiB | `false` |
| Tras otra petición a `/stt` (recarga perezosa) | 2407 MiB | `true` |

El log confirma la descarga: `STT model unloaded (idle 22s >= 20s)`.

## Endpoints

- `GET /health` — sin autenticación. Devuelve el modelo/dispositivo/estado
  de carga de STT y el motor/voces de TTS.
- `POST /stt` — cuerpo: bytes crudos de audio (`audio/webm`, `audio/ogg` o
  `audio/wav`; el navegador manda `audio/webm;codecs=opus` desde
  `MediaRecorder`). Query opcional `?lang=es|en|auto`. Límite: 20 MB.
- `POST /tts` — JSON `{"text", "lang", "voice"?, "speed"?}` → WAV 24 kHz
  mono 16 bits. Límite: 4000 caracteres. El texto se limpia de bloques de
  código, markdown y URLs antes de sintetizarlo (los bloques de código se
  leen como "(bloque de código)"/"(code block)", el código inline
  conserva su texto, los enlaces conservan su etiqueta).

Errores: siempre JSON `{"error": "..."}` con el código HTTP apropiado
(400/401/413/422/500).

## Instalación y arranque

```bash
bash scripts/install-voice.sh
```

Es idempotente: crea o reutiliza el venv dedicado en
`~/.local/share/phantom/voice-venv` (Python 3.12, separado de los venvs de
`brag` — no los toca), instala dependencias, verifica que los modelos de
kokoro ya existan en `~/.local/share/brag/models/` (sin duplicarlos) e
instala/recarga la unidad de usuario systemd.

## Operación

```bash
systemctl --user status phantom-voice     # estado
systemctl --user restart phantom-voice    # reiniciar
journalctl --user -u phantom-voice -f     # logs en vivo
ss -ltnp | grep 3091                      # confirmar que solo escucha en loopback
```

La unidad (`integrations/systemd/phantom-voice.service`) usa las mismas
cortesías de recursos que `phantom-desktop.conf` de `codeg.service`
(`CPUWeight=50`, `IOWeight=50`, `Nice=5`, `MemoryHigh=6G`,
`StartLimitBurst=5`), más `UMask=0077` porque el proceso lee el token de
`server.env`. Arranca con la sesión (`WantedBy=default.target`).

Para cambiar el tiempo de inactividad antes de liberar la VRAM del modelo
de STT (por ejemplo, para depurar), agregar un drop-in en vez de tocar el
archivo del repo:

```bash
systemctl --user edit phantom-voice.service
# [Service]
# Environment=PHANTOM_VOICE_IDLE_UNLOAD_S=60
systemctl --user restart phantom-voice
```
