# Constitución — clinica-api

> **Este archivo es derivado, no la fuente.** La constitución real de este
> proyecto es `CLAUDE.md` en la raíz del repositorio, y las decisiones que la
> sustentan están en los ADR del repositorio `clinica-docs`. Existe aquí porque
> los skills de Spec Kit lo leen. **Si algo aquí contradice a `CLAUDE.md`, gana
> `CLAUDE.md` y este archivo está desactualizado: corregirlo en el mismo commit.**

Sistema de gestión clínica para Ecuador. NestJS 11 · PostgreSQL 18 · Prisma ·
pnpm. Producción real en una clínica: un defecto aquí es un daño a un paciente o
una sanción, no un ticket.

## Principios no negociables

### I. Verificar antes de declarar hecho (NO NEGOCIABLE)

`pnpm verify` debe pasar entero: formato, tipos, lint, fronteras de arquitectura,
guarda de migraciones y pruebas unitarias. Si se toca la base, además
`pnpm test:integration`. Un hook impide cerrar el turno con código sin verificar.
Nada se declara terminado porque «funciona en mi máquina».

### II. Lo que la base garantiza se prueba contra la base (NO NEGOCIABLE)

Las reglas críticas viven en SQL: `EXCLUDE USING gist` para el no solapamiento de
agenda, triggers de inmutabilidad de notas firmadas, columnas generadas,
validación de cédula. Un doble que devuelve lo que le pedimos no demuestra que el
constraint exista. Testcontainers con PostgreSQL 18 real.

### III. Un idioma por capa

Todo el código en inglés —identificadores, archivos, tablas, columnas y
comentarios—. Español solo en textos que lee el usuario final y en documentación.
Los términos del dominio ecuatoriano no se traducen: `Cedula`, `RUC`, `CIE10`,
`SRI`, `IESS`, `RDACAA`, `ACESS`, `CNMB`.

### IV. Cerrado por defecto

Una ruta sin declaración explícita de permiso se rechaza, y una prueba recorre
las rutas que NestJS registró de verdad y falla si alguna no lo declara o amplía
la superficie pública. El alcance por sede se comprueba además del rol. Todo
acceso a historia clínica deja fila en la bitácora.

### V. El contrato de errores es público

`code` estable en inglés, `title` legible, separados y probados, sobre RFC 9457
con `application/problem+json`. Todo código nuevo entra en el catálogo congelado
`shared/domain/errors/error-catalogue.ts`, cuya prueba falla si diverge.
Renombrar un código rompe clientes.

### VI. La especificación vive junto al código

Todo módulo de dominio lleva su `src/modules/<m>/SPEC.md` con criterios de
aceptación en EARS e identificadores `<MOD>-###`. Un requisito vigente sin prueba
que lo nombre rompe el CI. La spec se corrige en el mismo commit que cambia el
comportamiento.

### VII. Sin sobreingeniería

Un patrón entra cuando resuelve un problema que ya existe en el código, no por
simetría con otro módulo. Un servicio por agregado, no por entidad. Investigar
antes de elegir una librería y presentar alternativa con su porqué.

### VIII. Zona horaria y datos personales

Toda fecha clínica se resuelve en `America/Guayaquil`, nunca con el huso de la
sesión. Nunca se interpolan variables en una llamada de log. Ninguna prueba usa
datos de una persona real.

## Restricciones que Spec Kit debe respetar

- **La especificación de un módulo se escribe en `src/modules/<m>/SPEC.md`**, no
  en `specs/###-feature/`. Los borradores de Spec Kit van a
  `.specify/drafts/<módulo>/` y se fusionan a mano en el `SPEC.md`.
- **Formato EARS**, no `FR-001: System MUST …`. Palabras clave fijadas: `CUANDO`,
  `MIENTRAS`, `SI … ENTONCES`, `DONDE`, y `DEBERÁ` como única obligación.
- Los requisitos de comportamiento usan el prefijo del módulo (`AG-###`); los
  criterios de éxito medibles usan `SC-###`.
- Las migraciones ya versionadas son inmutables. Nunca `prisma migrate dev` ni
  `prisma db push`: rehacen el esquema y borran lo escrito a mano.

**Versión:** 1.0.0 · **Ratificada:** 12 de agosto de 2026 · **Fuente:** `CLAUDE.md`
