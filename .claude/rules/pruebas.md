---
paths:
  - "src/**/*.spec.ts"
  - "test/**/*.ts"
---

# Pruebas

## Qué nivel prueba qué

| Nivel | Prueba | Sin acceso a | Dónde |
|---|---|---|---|
| Unitario | Reglas de dominio: políticas, cálculos, invariantes | red, base, reloj real | junto al código, `*.spec.ts` |
| Integración | Repositorios y **constraints contra PostgreSQL real** | — | `test/integration/` |
| Contrato HTTP | Estados, forma RFC 9457, campos de error, cabeceras | — | `test/` |
| Seguridad | Autorización horizontal y vertical, fuga de PHI | — | dirigidas |

**Lo que la base garantiza se prueba contra la base.** Un doble que devuelve lo
que le pedimos no demuestra que el `EXCLUDE` exista. Esta regla no admite
excepción por comodidad.

## Reglas que no se negocian

- **Ninguna prueba usa datos de una persona real.** Las cédulas de prueba llevan
  dígito verificador calculado, nunca copiado.
- Todo error tiene prueba de su contrato: `code` estable, estado HTTP y mensaje.
  El `code` es contrato público; cambiarlo rompe clientes.
- Los casos límite del dominio ecuatoriano tienen prueba propia: cédula
  inválida, provincia 30, tercer dígito ≥ 6, RUC de 13 dígitos, feriados, huso
  `America/Guayaquil`, IVA por ítem.
- Una prueba de concurrencia afirma **quién gana**, no que «al menos uno falle».
  Dos ganadores es el fallo que se busca.

## Trazabilidad

Si el módulo tiene `SPEC.md`, el título de la prueba **nombra el requisito**:

```ts
it('AG-023 rejects an overlapping booking for the same practitioner', () => {});
```

`spec-traceability.spec.ts` falla en las dos direcciones: requisito vigente sin
prueba, y prueba que cita un requisito inexistente. Citar un ID que no existe no
es un despiste: significa que el requisito se renombró o se borró y la prueba
quedó en verde probando otra cosa.

## Al escribir la prueba

- El título dice **qué comportamiento** se garantiza, no qué función se llama.
  `rejects a cedula whose check digit is wrong`, no `test validateCedula`.
- Nada de `expect(true).toBe(true)` ni aserciones que pasarían con el código
  borrado. Si la prueba no falla al romper el código, no prueba nada.
- Preferir una prueba que reproduzca el fallo real a tres que cubran líneas.
- Los umbrales de cobertura por capa están en `vitest.config.mts`: dominio 95 %.
  Por debajo no significa «faltan pruebas», significa código muerto o mal
  ubicado.
