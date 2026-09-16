# Arquitectura

Registra secretos en Azure Key Vault sin que ninguna persona teclee, cifre ni vea el valor. El
workflow lo **genera** en el runner y lo escribe en la bóveda con identidad federada.

El control que esto resuelve es de **segregación de funciones**: quien pide el secreto no lo maneja,
quien aprueba no lo ve, y nadie necesita el portal de Azure para registrarlo.

## Estructura

```
.github/
├── ISSUE_TEMPLATE/
│   └── registro-secreto.yml      # formulario de solicitud — sin campo para el valor
├── workflows/
│   └── registrar-secreto.yml     # validate → register (Azure) → report
└── scripts/
    ├── common.js                 # patrón del canario, label y referencias compartidas
    ├── validar-solicitud.js      # check al abrir, recheck justo antes de generar
    ├── generar-secreto.js        # genera el valor en el runner
    └── reportar-registro.js      # resultado, aprobador real y cierre
infra/
└── bootstrap.sh                  # todo lo de Azure, idempotente
```

Sin capas tipo `core/services/shared`: son cuatro scripts cortos. Lo compartido vive en `common.js`.

## Los tres planos

```mermaid
flowchart TD
    SQUAD["Squad<br/>(abre el issue)"] -->|solo metadatos| GITHUB["GitHub Actions<br/>(valida, espera aprobación, genera)"]
    ANALISTA["Analista de Seguridad"] -->|aprueba| GITHUB
    GITHUB -->|valor generado| AZURE["Azure Key Vault"]
```

- **Personas** — el squad pide y el Analista aprueba. Ninguno toca el valor.
- **GitHub** — valida, orquesta y genera. El valor vive solo dentro de un step del runner.
- **Azure Key Vault** — el único lugar donde el valor queda guardado.

## Flujo

```mermaid
sequenceDiagram
    participant Squad
    participant Issue
    participant V as validate
    participant Analista
    participant R as register
    participant KV as Key Vault
    participant Rep as report

    Squad->>Issue: abre solicitud (solo metadatos)
    Issue->>V: on: issues opened
    V->>Issue: comenta resultado · cierra si es inválida
    V-->>R: hash del issue validado
    Analista->>R: aprueba en el environment
    R->>Issue: relee: mismo hash, abierto, sin registrar
    R->>R: genera el valor en memoria
    R->>KV: az keyvault secret set (con expiración)
    R->>KV: intenta leerlo de vuelta
    KV--)R: 403 Forbidden
    Rep->>Issue: resultado + aprobador · label registrado · cierra
```

Todo ocurre en **un único issue**: pedido, validación, aprobación y resultado quedan en el mismo
hilo, así la trazabilidad se lee de corrido.

## Decisiones de diseño

**Nadie teclea el valor: lo genera el sistema.** Cualquier paso donde una persona escribe o pega el
valor abre un canal de fuga y rompe la segregación. Generarlo en el runner elimina ese tramo. Solo
aplica a secretos que un sistema puede emitir por API; el resto queda fuera de alcance.

**El rol permite escribir, no leer.** Los roles integrados de Key Vault no sirven: *Secrets User*
solo lee y *Secrets Officer* hace todo, incluido `getSecret`. Con el integrado, el pipeline podría
releer lo que acaba de escribir. Por eso `bootstrap.sh` define un rol con **una sola dataAction**,
`Microsoft.KeyVault/vaults/secrets/setSecret/action`, y el workflow comprueba en cada corrida que la
lectura siga denegada. Si alguien amplía esos permisos, el registro falla y se nota.

**Identidad administrada, no App Registration.** El tenant donde corre este lab tiene
`allowedToCreateApps: false`, así que registrar una aplicación no era posible. Una *user-assigned
managed identity* es un recurso de la suscripción y admite credenciales federadas igual. Terminó
siendo la mejor opción por otro motivo: no hay ningún secreto de cliente que rotar ni que se pueda
filtrar — el ciclo de vida lo maneja Azure entero.

**El subject de OIDC se lee de la API, no se escribe a mano.** GitHub firma el token con los IDs
numéricos inmutables del dueño y del repo:
`repo:Ox19@57415456/registry-secret-automation@1373060850:environment:registro-secretos`. Escribir
el nombre pelado hace fallar el login con `AADSTS700213`.

El subject lleva **nombre e ID a la vez**, así que **renombrar el repo o la cuenta rompe el login**:
hay que volver a correr `bootstrap.sh`, que lo relee de la API. Lo que el ID aporta es otra garantía:
nadie puede crear después un repo con el nombre viejo y heredar el permiso, porque tendría otro ID.

**El valor pasa por archivo, no por argumento.** `--value` dejaría el secreto en la línea de comandos,
visible para cualquier proceso del runner con `ps`. Va por un archivo temporal con permisos `600` y
un `trap` que lo borra pase lo que pase.

**Un solo workflow, disparado al abrir el issue.** `register` depende de `validate`: una solicitud
rechazada nunca llega a pedir aprobación. Editar el issue no la reprocesa; para corregir se abre otro.

**Lo aprobado es lo validado.** `validate` emite el hash del cuerpo del issue. `register` lo relee
justo antes de generar y aborta si cambió, si ya no está abierto o si tiene el label `registrado`.

**El environment va en el job que genera.** La aprobación pausa exactamente el job que crea el valor,
y el `sub` de OIDC solo se emite a un job que declare el environment. Un job que se saltee la
aprobación no obtiene un token que Azure acepte.

**Repositorio dedicado.** La credencial federada se acota a este repo y environment. En un repo
compartido, cualquier workflow podría pedir el token que escribe en el Key Vault.

**El control real no es el enmascarado.** `::add-mask::` tapa coincidencias exactas en los logs, pero
no un valor transformado ni una exfiltración deliberada — el runner tiene salida de red. Lo que
protege de verdad es **quién puede modificar estos archivos**. En este lab no hay `CODEOWNERS` ni
protección de rama: es de un solo dueño. En un entorno corporativo esa protección es obligatoria y
no opcional.

**El valor no sale de su step.** No va a `GITHUB_ENV` ni a un argumento: nace, se registra y muere en
el mismo step, lejos de las acciones de terceros de los pasos siguientes.

**El aprobador sale de la revisión, no de `github.actor`.** En un evento `issues`, `github.actor` es
quien abrió el issue, no quien aprobó.

**Acciones ancladas al SHA, no a la etiqueta.** Una etiqueta se puede reapuntar a otro código; un SHA
no. Estas acciones corren en el mismo job que genera el valor.

**Permisos mínimos por job.** `permissions: {}` a nivel global. `register`, el único job que tiene el
valor, no puede escribir en el issue; su `id-token: write` sirve solo para pedir el token de Azure.

## Estado

Funciona contra un Azure real: login federado, registro con expiración, lectura denegada y cero
apariciones del valor en logs y en el issue.

Falta **la pausa de aprobación**: los revisores obligatorios en un repo privado requieren GitHub Pro.
Hasta entonces el job de registro corre sin detenerse. El valor registrado es un canario con formato
reconocible, no una credencial real.

## Fuera de alcance

- Secretos sin API para generarse: llaves de GitHub App, credenciales on-prem, proveedores externos.
- La **lectura** de secretos por las aplicaciones: es otra fase.
- Rotación y expiración automática: acá la fecha se declara, no se hace cumplir.
- Dependencias npm: los scripts usan solo módulos nativos de Node.
