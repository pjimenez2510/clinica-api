---
paths:
  - "src/modules/*/domain/**/*.ts"
  - "src/shared/domain/**/*.ts"
---

# Capa de dominio

Código puro: sin I/O, sin framework, sin reloj. `pnpm arch:check` lo verifica y
falla si esta capa importa de `application`, de `infrastructure`, de NestJS o de
Prisma.

## Consecuencias prácticas

- **Nada de decoradores de NestJS aquí.** Ni `@Injectable()`, ni `@Inject()`.
  Si hace falta inyectar algo, el dominio declara el tipo y el cableado ocurre
  fuera.
- **El tiempo entra como parámetro**, no se lee. `new Date()` dentro del dominio
  hace la regla imposible de probar sin viajar en el tiempo.
- Los value objects validan en su constructor o en un `create()` que devuelve el
  error, y son inmutables una vez creados.

## Errores

- Una regla de negocio o invariante define su error en
  `modules/<m>/domain/<m>.errors.ts`; el de un value object vive junto al value
  object.
- **La infraestructura lanza errores de dominio; no los define.**
- Todo código nuevo entra en `shared/domain/errors/error-catalogue.ts`, y
  `error-catalogue.spec.ts` falla si diverge. Es intencionadamente incómodo: el
  `code` es contrato público.
- El error lleva `code` estable en inglés (`WEAK_PASSWORD`). El texto que lee el
  usuario va aparte y en español.

## Términos del dominio ecuatoriano

Se mantienen tal cual, como nombres propios: `Cedula`, `RUC`, `CIE10`, `SRI`,
`IESS`, `RDACAA`, `ACESS`, `CNMB`. Lo que los rodea va en inglés:
`Cedula.create()`, nunca `Cedula.crear()`.

## Tamaño

Un servicio por **agregado**, no por entidad. Se parte cuando cruza cualquiera
de estos tres límites: más de ~8 casos de uso públicos, dos grupos de métodos
sin dependencias comunes, o dos motivos de cambio distintos. El número de líneas
por sí solo no es motivo.
