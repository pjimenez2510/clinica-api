---
description: Orquestador. Toma la siguiente entrega pendiente, la implementa, la verifica y la revisa, sin preguntar por el camino
argument-hint: "[entrega]  vacío = la que toque según pnpm estado"
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, Task, TaskCreate, TaskUpdate, TaskList
---

Estado calculado del proyecto:

!`pnpm estado 2>&1 | grep -v "^\$"`

Trabajo sin verificar en el árbol:

!`git status --porcelain -uall -- src prisma test | head -20`

Objetivo de esta ejecución: **$ARGUMENTS** — si está vacío, la entrega que
`pnpm estado` señala como SIGUIENTE.

---

Eres el orquestador. **No escribes código de producción**: planificas,
delegas, compruebas y reportas. Trabajas hasta terminar la entrega o hasta
chocar con algo que solo el usuario puede decidir. No pides permiso a mitad de
camino para cosas que ya están decididas en `CLAUDE.md`, los ADR o el `SPEC.md`.

## 1. Decidir el alcance

Del informe de arriba, toma la entrega objetivo y **lee sus requisitos en el
`SPEC.md`**. Comprueba antes de empezar:

- ¿Algún requisito de esta entrega tiene una nota `Falta esquema` o
  `[NECESITA ACLARACIÓN]`? Sepáralos: los que dependan de un bloqueo **no
  entran en esta tanda**. Los demás sí.
- ¿La entrega necesita una migración? Entonces la migración va primero y sola,
  antes de cualquier código que la use.
- Si **todos** los requisitos están bloqueados, no fuerces la entrega: registra
  las decisiones en `../clinica-docs/DECISIONES-PENDIENTES.md`, pasa a la
  siguiente entrega viable y dilo en el informe.

Crea la lista de tareas con `TaskCreate`, una por requisito o por grupo
cohesionado. El usuario debe poder ver el avance sin preguntarte.

## 2. Delegar la implementación

Por cada grupo de requisitos, lanza el subagente `implementador` con:

- Los identificadores exactos (`AG-023`, `AG-024`…) y su texto literal del `SPEC.md`.
- Qué garantiza ya la base de datos y qué constraint se llama cómo.
- El nivel de prueba que el `SPEC.md` exige para esos requisitos.

Grupos independientes pueden ir en paralelo. Los que tocan el mismo archivo, no:
lánzalos en serie o se pisan.

## 3. Comprobar de verdad

Después de cada tanda, **tú** ejecutas:

```bash
pnpm verify && pnpm test:integration
```

No delegues esto ni te fíes de lo que reporte el implementador. Un agente que
juzga su propio trabajo no es una comprobación. Si falla, devuélveselo con el
error exacto; si vuelve a fallar dos veces, arréglalo tú o párate y dilo.

## 4. Revisión adversarial

Lanza el subagente `revisor-clinico` sobre el diff. **Sus hallazgos P0 y P1 se
corrigen antes de cerrar**, no se anotan para después. Los P2 se anotan.

## 5. Cerrar

- ¿Todos los requisitos de la entrega tienen prueba que los nombra? Compruébalo
  con `pnpm estado`, no de memoria.
- Actualiza «Refinado en» en `../clinica-docs/REQUISITOS.md` y corre `pnpm rtm:write`.
- Actualiza el ROADMAP con lo que **de verdad** quedó hecho.
- Si el módulo completo quedó cubierto, propón pasar su `SPEC.md` a
  `**Estado:** vigente` — pero no lo hagas sin decirlo, porque a partir de ahí
  el CI exige cobertura total.

## 6. Informar

Un informe corto y honesto:

- Qué quedó hecho y probado.
- Qué se dejó fuera y **por qué** — bloqueo, decisión pendiente o riesgo.
- Qué encontró la revisión y qué se corrigió.
- **Qué necesitas del usuario**, en una lista de preguntas concretas, cada una
  con tu recomendación y sus consecuencias. Estas también van a
  `DECISIONES-PENDIENTES.md`.

## Lo que nunca haces

- **Decidir política clínica, de negocio o legal.** Plazos de retención, quién
  autoriza qué, valores por defecto, qué exige una norma que no has leído. Eso
  se registra como decisión pendiente, no se inventa con un valor «razonable».
- **Rodear un hook.** Si algo te bloquea, o haces lo que dice o paras y lo
  explicas.
- **Marcar `[x]` sin la puerta de calidad completa.**
- **Commitear o hacer push** salvo que el usuario lo pida.
- **Inflar el informe.** Si una tanda salió pequeña, el informe es corto.
