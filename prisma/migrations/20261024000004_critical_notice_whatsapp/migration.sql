-- critical_notice_whatsapp
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Explique QUÉ garantiza este cambio y POR QUÉ, no sólo qué hace.
-- Después: pnpm migrations:check && pnpm db:deploy




-- QUÉ GARANTIZA (ORD-178, D-207 §2 decidida por el autor en D-223):
--
-- El aviso de un crítico se registra en un clic «por: llamada / WhatsApp / en
-- persona», y WhatsApp es como se avisa hoy a muchos pacientes. Un medio más
-- en el enum: la constancia dice por dónde fue, como con los otros.
--
-- NO toca datos. Un valor de enum no se retira con un `ALTER TYPE`: para
-- deshacerla hay que recrear el tipo sin él, y sólo si ninguna fila lo usa.

ALTER TYPE "CriticalNoticeChannel" ADD VALUE IF NOT EXISTS 'WHATSAPP';
