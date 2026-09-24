# Phantom: control-plane local, agentes iguales

## Decisión

Phantom usa Codeg como motor local de servidor, UI, ACP y
broker. El nombre `codeg` se conserva internamente donde forma parte de APIs,
MCP, rutas o almacenamiento compatibles.

El sistema es **híbrido**, no un único modelo central ni una malla peer-to-peer:

```text
                         usuario / permisos
                                |
                       codeg-server (UI + estado)
                        /        |         \
                 OpenCode   Claude Code   Hermes
                   ACP        ACP          ACP
                        \        |         /
                         codeg-mcp broker
                                |
                  handoffs, tareas, historial, eventos
```

## Qué está centralizado

`codeg-server` es el plano de control local:

- mantiene la vista unificada y el índice de conversaciones;
- conserva el estado de streaming, permisos y aprobaciones;
- ofrece HTTP/WebSocket a la UI;
- lanza y supervisa los procesos ACP;
- registra handoffs y resultados.

`codeg-mcp` es el broker de delegación local. No es un modelo: solo enruta una tarea a un agente y devuelve el resultado.

## Qué está descentralizado

Cada agente conserva su propio:

- proceso y contexto;
- credenciales;
- modelo y effort;
- herramientas y permisos;
- historial nativo.

Por eso una sesión de Claude no se presenta como si OpenCode hubiera recibido automáticamente todo su contexto. Las transferencias son explícitas y visibles.

## Igualdad de peso

No existe un agente maestro permanente. En cada tarea, el usuario puede elegir cualquiera como lead. Un lead que acepta MCP puede delegar a los otros; los tres pueden ser workers. La palabra *lead* es un rol de esa tarea, no una jerarquía global.

El orden del selector (OpenCode, Claude Code, Hermes) solo mejora la experiencia de selección. Puede cambiarse en `Settings -> Agents` sin cambiar la arquitectura.

## Frontera de autoridad

1. El usuario decide objetivo, aprobaciones y permisos.
2. Codeg hace cumplir el plano de control y registra las acciones.
3. Los agentes ejecutan usando sus propias capacidades, pero no pueden autoaprobar una acción ni transferir consentimiento a otro agente.

## Puerta de revisión final

Después de compilar y probar el backend, `scripts/final-review.sh` ejecuta una sesión de solo lectura con Claude Code Opus 5.5. El agente revisor no es el coordinador de producción: solo audita la entrega y sus hallazgos se aplican antes del cierre.

## Consecuencias

- Un cambio de modelo/agente no comparte mágicamente el contexto: se requiere un handoff visible.
- Dos agentes que editan el mismo archivo pueden entrar en conflicto; para trabajo paralelo se usa un worktree.
- El historial se unifica para navegar, pero la fuente de verdad de cada sesión sigue siendo el agente que la creó.
- El centro es local y loopback-only; no hay una nube Codeg intermedia.
