---
paths:
  - "src/modules/*/SPEC.md"
---

# Especificaciones de módulo

## Formato EARS

Estructura: `MIENTRAS <precondición>, CUANDO <disparador>, el sistema DEBERÁ <respuesta>`.
Cero o más precondiciones, cero o un disparador, una o más respuestas.

| Patrón | Palabra clave | Cuándo |
|---|---|---|
| Ubicuo | *(ninguna)* | Siempre activo |
| Evento | `CUANDO` | Reacción a un disparador |
| Estado | `MIENTRAS` | Mientras dure una condición |
| No deseado | `SI … ENTONCES` | Error, fallo, abuso |
| Opcional | `DONDE` | Solo si la instalación tiene esa característica |

**`DEBERÁ` es la única forma de obligación.** No existe «debería», «podría» ni
«se recomienda»: un requisito que no es obligatorio no es un requisito. La
negación es `NO DEBERÁ`.

No se inventan sinónimos de las palabras clave. Media docena de formas de decir
«cuando» destruye lo único que EARS aporta.

## Identificadores

- Comportamiento: `<MOD>-###` por orden de aparición (`AG-023`). **Nunca se
  reutiliza un número.** Si un requisito se elimina, su ID queda muerto.
- Criterios de éxito medibles: `SC-###`. Se verifican con carga, e2e u
  observación, no con pruebas unitarias.
- Los identificadores del código se citan literales y sin traducir:
  `AgendaStatus.NO_SHOW`, `agenda_entry_no_practitioner_overlap`,
  `PRACTITIONER_SLOT_TAKEN`.

## Estado del documento

`**Estado:** borrador …` — solo se comprueba que esté bien formado.
`**Estado:** vigente` — **cada requisito necesita una prueba que lo nombre**, o
el CI falla. Promover a vigente es asumir esa responsabilidad.

## Qué debe llevar

Alcance y fuera de alcance · vocabulario con el significado exacto ·
entregas priorizadas e independientemente comprobables · requisitos EARS ·
criterios de éxito `SC-###` · supuestos · códigos de error nuevos ·
niveles de prueba por requisito · preguntas abiertas.

## Cómo escribir un requisito que sirva

- **Verificable o no es un requisito.** «Visualmente distinguido» no lo es;
  «expone el indicador en la respuesta» sí.
- **Nada de presentación en la spec del backend.** Cómo se ve es de
  `clinica-web`.
- Si el requisito necesita un campo que **el esquema no tiene**, se dice ahí
  mismo con una nota `> **Falta esquema.**`. Descubrirlo al implementar produce
  el atajo de guardarlo en un texto libre que nadie puede recorrer.
- Lo ambiguo se marca `> **[NECESITA ACLARACIÓN]**` **junto al requisito**, no
  al final del documento. Una pregunta separada del requisito que bloquea no
  bloquea nada.
- Enumerar en lugar de referenciar: «los grupos prioritarios de la Constitución»
  no es especificar; la lista sí.

## El nombre del archivo

Siempre `SPEC.md`. **Nunca se escribe `spec.md` dentro de `src/modules/`**: este
sistema de archivos no distingue mayúsculas y destruiría el `SPEC.md`. Un hook
lo bloquea.
