# Flujo de trabajo paralelo

## Prometa de dos compañeros

Cada agente es independiente. El lead solo coordina el turno actual.

```text
Usuario
  |
  +--> Claude Code  (proceso/contexto/modelo propios)
  |
  +--> Hermes      (proceso/contexto/modelo propios)
  |
  +--> OpenCode    (proceso/contexto/modelo propios)
```

`codeg-server` y `codeg-mcp` no son un modelo central: solo mantienen la sesión, envían las tareas y reciben los resultados.

## Petición de dos modelos

En Codeg se puede escribir:

```text
@Claude Code revisa la seguridad del cambio y devuelve hallazgos.
@Hermes ejecuta los tests y devuelve un informe.
Trabajen en paralelo y no editen los mismos archivos.
Cuando terminen, resume ambos resultados.
```

El mention `@Agente` es una instrucción explícita de delegación. El agente que lleva la conversación puede emitir varias tareas sin esperar a que termine la anterior.

## Aislamiento

- independencia de contexto: automática;
- independencia de proceso: automática;
- independencia de modelo/credenciales: automática;
- archivos compartidos: usar un worktree por tarea;
- permisos: cada worker conserva su propia pantalla de aprobación;
- resultado: cada worker conserva su sesión y transcript.

## Regla de seguridad

No dos tareas paralelas deben editar el mismo archivo sin worktrees. La coordinación no elimina conflictos de filesystem; los hace explícitos.
