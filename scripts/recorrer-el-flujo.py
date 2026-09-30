#!/usr/bin/env python3
"""
Recorre el flujo de atención completo contra la API que está corriendo.

    pnpm start                      # en otra terminal
    python3 scripts/recorrer-el-flujo.py

PARA QUÉ SIRVE, Y QUÉ NO ES. No sustituye a `pnpm test:integration`: aquella
prueba las garantías una a una contra PostgreSQL, ésta comprueba que las
piezas encajan **por HTTP, en el orden en que ocurren en la clínica**. Es la
diferencia entre saber que cada pieza funciona y saber que la consulta de las
13:20 llega hasta la factura.

Sirve para tres cosas: enseñar el sistema sin hacer clic, detectar que dos
módulos dejaron de entenderse aunque sus pruebas sigan verdes, y dar de alta
datos de demostración con un solo comando.

Requiere `pnpm db:seed && pnpm db:seed:patients && pnpm db:seed:agenda`.

Un paso marcado ✓ con código 4xx no es un error: hay pasos que COMPROBAMOS QUE
FALLAN —editar una nota firmada, por ejemplo—, y ahí el rechazo es el éxito.
"""

import datetime
import json
import urllib.error
import urllib.request

API="http://localhost:3000/api/v1"; TOK=None
def call(m,p,b=None):
    r=urllib.request.Request(API+p,method=m,data=json.dumps(b).encode() if b is not None else None)
    r.add_header('content-type','application/json')
    if TOK: r.add_header('authorization','Bearer '+TOK)
    try:
        with urllib.request.urlopen(r) as x: return x.status, json.loads(x.read() or b'null')
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read() or b'null')
        except Exception: return e.code, None
def show(step, st, d, keys=(), expect_refusal=False):
    good = (st not in (200, 201)) if expect_refusal else (st in (200, 201))
    extra = ''
    if expect_refusal and not st in (200, 201):
        extra = ' · rechazado como debe: ' + str(d.get('code') if isinstance(d, dict) else '')
    elif st not in (200, 201) and isinstance(d, dict):
        extra = ' · ' + str(d.get('code') or d.get('title') or d.get('detail') or d)[:110]
    elif keys and isinstance(d, dict):
        extra = ' · ' + ' '.join(f"{k}={d.get(k)}" for k in keys if k in d)
    print(f"{'✓' if good else '✗'} {step:<44} {st}{extra}")
    return d

st,d=call('POST','/auth/login',{"email":"admin@clinica.ec","password":"el caballo come alfalfa"})
TOK=d['accessToken']; print("── FLUJO DE ATENCIÓN, DE PRINCIPIO A FIN ──\n")
today=datetime.date.today().isoformat()
st,sites=call('GET','/organization/sites')
site=[s for s in sites['items'] if 'Norte' in s['name']][0]
st,d=call('GET',f"/agenda/sites/{site['id']}/entries?date={today}")
appts=[e for e in d['items'] if e.get('kind')=='APPOINTMENT']
prac=appts[0]['practitionerId']

# SIN CITA, que es la otra mitad de la consulta externa (AG-029, EN-003):
# el paciente que simplemente llega. Evita además chocar con la restricción de
# una atención por cita al repetir la prueba.
st,pl=call('GET','/patients?take=40')
adults=[x for x in pl['items'] if (x.get('ageYears') or 0) >= 18]
pat=(adults or pl['items'])[0]
print(f"  Paciente SIN CITA: {pat.get('displayName') or pat.get('lastName')}  ·  {site['name']}\n")

st,enc=call('POST','/encounters',{
  "siteId":site['id'],"patientId":pat['id'],
  "practitionerId":prac,
  "careModality":"MORBIDITY","visitSequence":"FIRST_TIME",
  "startedAt":datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00","Z")})
show("1. abrir la atención (encounter:open)",st,enc,('id','status'))
if st not in (200,201): raise SystemExit
eid=enc['id']

st,d=call('POST',f"/encounters/{eid}/vitals/start")
show("2. enfermería empieza la preparación",st,d,('status',))

st,d=call('PUT',f"/encounters/{eid}/vitals",{
  "weightKg":14.2,"heightCm":92.0,"headCircumferenceCm":48.5,"abdominalCircumferenceCm":47.0,"systolicBp":95,"diastolicBp":60,
  "heartRate":110,"respiratoryRate":24,"temperatureC":36.7})
show("3. signos vitales (IMC lo calcula el sistema)",st,d,('bmi',))

st,note=call('POST',f"/encounters/{eid}/notes",{
  "formCode":"002","formVersion":"1",
  "content":{"motivoConsulta":"Fiebre de dos días de evolución",
             "antecedentes":"Sin antecedentes patológicos de importancia.",
             "enfermedadActual":"Alza térmica de hasta 38.5°C, sin tos ni diarrea.",
             "revisionOrganosSistemas":"Sin hallazgos en el resto de sistemas.",
             "examenFisico":"Activo, hidratado. Faringe eritematosa. Resto sin hallazgos.",
             "planTratamiento":"Hidratación, control de temperatura y cita en 7 días."}})
show("4. escribir la nota clínica (formulario 002)",st,note,('id','status'))

# Buscamos un CIE-10 real en el catálogo: el diagnóstico NO se escribe a mano.
st,cat=call('GET','/catalogs/CIE10?q=J02&limit=5')
concepts=cat.get('items',[]) if isinstance(cat,dict) else []
if not concepts:
    st,cat=call('GET','/catalogs/CIE10?q=J02&limit=5')
    concepts=cat.get('items',[]) if isinstance(cat,dict) else []
if concepts:
    dx=concepts[0]
    st,d=call('POST',f"/encounters/{eid}/diagnoses",
              {"conceptId":dx['id'],"certainty":"PRESUMPTIVE","occurrence":"FIRST_TIME"})
    show(f"5. diagnóstico CIE-10 {dx.get('code','')}",st,d,('rank','certainty'))
else:
    print("  (sin catálogo CIE-10 sembrado: paso omitido)")

# ── Receta y exámenes, antes de firmar: firmar el 002 da el alta ──────────
st,cnmb=call('GET','/catalogs/CNMB?q=paracetamol&limit=5')
meds=cnmb.get('items',[]) if isinstance(cnmb,dict) else []
if meds:
    st,rx=call('POST',f"/encounters/{eid}/prescriptions",
        {"items":[{"conceptId":meds[0]['id'],
                   "presentation":"Tableta","concentration":"500 mg",
                   "routeCode":"ORAL","quantity":9,
                   "doseText":"1 tableta","frequencyText":"cada 8 horas",
                   "durationDays":3}]})
    # La respuesta trae DOS cosas: la receta y los avisos de alergia. Que el
    # aviso viaje junto a lo que lo provoca es lo que evita una segunda llamada
    # —y una pantalla que muestre la receta antes de saber si hay conflicto.
    body = rx.get('prescription') if isinstance(rx, dict) else None
    alerts = rx.get('allergyAlerts') or [] if isinstance(rx, dict) else []
    show(f"6. receta: {meds[0].get('display','')[:24]}",st,body or {},('id','status'))
    if alerts:
        print(f"   ⚠️ {len(alerts)} aviso(s) de alergia")
    if isinstance(body,dict) and body.get('id'):
        st,d=call('POST',f"/prescriptions/{body['id']}/issue")
        show("7. emitir la receta",st,d,('status','verificationCode'))
        st,doc=call('GET',f"/prescriptions/{body['id']}")
        if st==200 and isinstance(doc,dict):
            q=(doc.get('items') or [{}])[0]
            print(f"   documento: vigencia={doc.get('validUntil') or doc.get('validityDays')} · cantidad='{q.get('quantityInWords') or q.get('quantity')}'")
else:
    print("  (CNMB sin resultados: receta omitida)")

st,exams=call('GET','/exams?limit=5')
items=exams.get('items',[]) if isinstance(exams,dict) else []
st,tar=call('GET','/catalogs/TARIFF?q=EX-&limit=5')
concepts=tar.get('items',[]) if isinstance(tar,dict) else []
if items and concepts:
    ex=items[0]
    match=[c for c in concepts if c.get('code')==ex.get('code')] or concepts
    st,order=call('POST',f"/encounters/{eid}/orders",
        {"category":"LABORATORY","priority":"ROUTINE",
         "items":[{"examDefinitionId":ex['id'],"conceptId":match[0]['id']}]})
    show(f"8. orden de examen: {ex.get('name','')[:26]}",st,order,('id','status'))
    st,pend=call('GET','/orders/pending?limit=20')
    n=len(pend.get('items',[])) if isinstance(pend,dict) else 0
    print(f"   cola de órdenes sin resultado: {n}")
else:
    print("  (sin exámenes o sin tarifario: orden omitida)")

if isinstance(note,dict) and note.get('id'):
    st,d=call('POST',f"/encounters/{eid}/notes/{note['id']}/sign",{"dischargeCondition":"ALIVE"})
    show("9. firmar la nota (el 002 da el alta)",st,d,('status',))
    st,d=call('PATCH',f"/encounters/{eid}/notes/{note['id']}",{"content":{"motivoConsulta":"otra cosa"}})
    show("10. editar la nota firmada",st,d,expect_refusal=True)

st,d=call('POST',f"/encounters/{eid}/close",{"dischargeCondition":"ALIVE"})
show("11. cerrar la atención con condición de egreso",st,d,('status',))

print()
st,payers=call('GET','/billing/payers')
particular=[p for p in payers['items'] if p['code']=='PARTICULAR'][0]
st,acc=call('POST',f"/billing/sites/{site['id']}/accounts",
            {"patientId":pat['id'],"encounterId":eid,"payerId":particular['id']})
if st==409:
    st2,al=call('GET',f"/billing/sites/{site['id']}/accounts?patientId={pat['id']}")
    open_accs=[a for a in al.get('items',[]) if a.get('status')=='OPEN']
    if open_accs: acc=open_accs[0]; st=200; print("  (reutilizando la cuenta abierta)")
show("12. abrir la cuenta con su pagador",st,acc,('id','status'))

if st in (200,201):
    aid=acc['id']
    st,svcs=call('GET','/billing/services')
    consulta=[x for x in svcs['items'] if 'onsulta' in x['name']][0]
    st,ch=call('POST',f"/billing/sites/{site['id']}/accounts/{aid}/charges",
               {"billableServiceId":consulta['id'],"quantity":"1",
                "serviceDate":datetime.date.today().isoformat()})
    show(f"13. cargo: {consulta['name'][:28]}",st,ch,('unitAmount','taxSriCode'))

    st,d=call('GET',f"/billing/sites/{site['id']}/accounts/{aid}")
    if st==200:
        print(f"   cuenta: {d.get('status')} · cargos={len(d.get('charges',[]))} · total={d.get('total')}")
